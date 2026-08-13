import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext, resolveBrandIn } from '../security/actor-context';
import { PersonMembersClient, toPersonRpc } from '../person/person-members.client';
import { inPortfolio, narrowsToPortfolio } from './portfolio-scope';
import {
  clampPageSize,
  decodeOrderedCursor,
  portfolioFingerprint,
  encodeOrderedCursor,
  InvalidCursorError,
} from '../shared/cursor';
import { toSummaryWire, toDetailWire, wireToSlaOutcome, wireToConversationOrder } from '../shared/wire';
import { StatusRepository } from '../status/status.repository';
import { resolveStatusFilter, StatusFilterError } from '../status/status-filter';
import { SlaRepository } from '../sla/sla.repository';
import { OperatorIdentityClient } from '../shared/operator-identity.client';
import { ReadMarkRepository } from './read-mark.repository';
import { PrismaService } from '../prisma.service';
import { TransitionRecorder } from '../transition/transition.recorder';
import { lookupPerformed, userActor } from '../transition/conversation-transitions';
import {
  ConversationRepository,
  DEFAULT_INBOX_ORDER,
  isConversationOrderKey,
} from './conversation.repository';

// proto-loader (keepCase:false) delivers camelCase request objects.
interface ListConversationsRequestWire {
  /** ⚠️ Feature 032: the DEPRECATED enum filter. Present so it can be REFUSED, never mapped (spec §4). */
  status?: string;
  /** Feature 032: an exact status key, validated against the account's catalogue. */
  statusKey?: string;
  /** Feature 032: a category from the closed catalogue, resolved into that account's keys. */
  statusCategory?: string;
  priority?: string;
  assigneeOperatorId?: string;
  playerId?: string;
  brandId?: string;
  pageToken?: string;
  pageSize?: number;
  /** Feature 014: '' / UNSPECIFIED = no filter; otherwise running | met | breached. */
  slaOutcome?: string;
  /** Feature 029: '' = no filter on channel — NOT "conversations with no channel". */
  channel?: string;
  /** Feature 029: '' / UNSPECIFIED = the default order (updated_desc), never "unordered". */
  order?: string;
  /** W5 (R38): the plural category filter — «Ждут» is a UNION the singular cannot say. */
  statusCategories?: string[];
  /** W5 (roadmap 4.19): only conversations this operator has OPENED — the rail's middle predicate. */
  openedByOperatorId?: string;
}
interface GetConversationRequestWire {
  id: string;
}

/**
 * ChatsReadService — conversation reads (feature 012, US1). Gated at BOTH tiers: the gateway
 * `@RequiresPermission` + this service-tier `ChatsAccessGuard` (Principle II / SC-004). Account +
 * brand scope come from the gateway-set metadata (`x-actor-*`); list is confined to the account
 * (Principle I) and intersected with the caller's permitted brands (R3). Keyset paging (R7).
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class ConversationReadController {
  constructor(
    @Inject(ConversationRepository) private readonly repo: ConversationRepository,
    @Inject(SlaRepository) private readonly sla: SlaRepository,
    @Inject(PersonMembersClient) private readonly person: PersonMembersClient,
    @Inject(StatusRepository) private readonly statuses: StatusRepository,
    // ── W5 (roadmap 4.19): the two halves of "he OPENED it" ────────────────────────────────────────
    @Inject(OperatorIdentityClient) private readonly operatorIdentity: OperatorIdentityClient,
    @Inject(ReadMarkRepository) private readonly readMarks: ReadMarkRepository,
    // W9 / spec 035: the lookup proxy writes the restricted transition itself.
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransitionRecorder) private readonly transitions: TransitionRecorder,
  ) {}

  /**
   * The caller's portfolio scope, or `undefined` when they are not portfolio-scoped (feature 030,
   * roadmap 4.14).
   *
   * ⚠️ **Fail closed.** If the portfolio cannot be established the read must FAIL, never fall back to an
   * unnarrowed list — an unavailable `users` and "attached to nobody" are indistinguishable unless one of
   * them is an error, and the wrong one of those hands over every VIP conversation in the account. The
   * refusal keeps the downstream status (a 403 stays a 403) so *"you may not ask this"* and *"the source
   * is down"* remain different facts.
   */
  private async portfolioScope(metadata: Metadata) {
    if (!narrowsToPortfolio(metadata)) return undefined;
    try {
      return await this.person.attachedPlayersOfCaller(metadata);
    } catch (err) {
      throw toPersonRpc(err);
    }
  }

  @GrpcMethod('ChatsReadService', 'ListConversations')
  @RequiresChatsPermission('crm.inbox.view')
  async listConversations(req: ListConversationsRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);

    // Feature 029 — the order is resolved FIRST, because the page token is validated against it.
    // An unrecognised order is refused, never coerced to the default: a list silently in a different
    // order than the caller asked for is the confidently-wrong-answer shape (the 012 lesson).
    /**
     * ⭐ Feature 032 — the status filter, resolved against the ACCOUNT's catalogue before anything else
     * runs. Deliberately first: it is the cheapest refusal (nine indexed rows) and it means a bad filter
     * never causes a portfolio lookup in another service, nor a page of somebody's conversations.
     */
    let statusIn: string[] | undefined;
    try {
      statusIn = await resolveStatusFilter(this.statuses, ctx.accountId, req);
    } catch (e) {
      if (e instanceof StatusFilterError) {
        throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: e.message });
      }
      throw e;
    }

    const orderWire = wireToConversationOrder(req.order);
    if (orderWire === null || (orderWire !== undefined && !isConversationOrderKey(orderWire))) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid order' });
    }
    const order = orderWire ?? DEFAULT_INBOX_ORDER;

    /**
     * ⚠️ Resolved BEFORE the page token is decoded, because the token is validated **against it**
     * (FR-014). A scope change is the order hazard by another door: same order, different row set, so a
     * token minted under the previous portfolio would page a sequence that no longer exists — silently.
     */
    const portfolioIn = await this.portfolioScope(metadata);
    const scopeFingerprint = portfolioIn ? portfolioFingerprint(portfolioIn) : undefined;

    let cursor;
    try {
      // ⭐ The token must have been minted under THIS order (research R8). Replaying one from the other
      // order would decode fine and then page a different sequence — a plausible list with rows
      // missing, invisible to whoever is reading it.
      cursor = decodeOrderedCursor(req.pageToken, order, scopeFingerprint);
    } catch (e) {
      if (e instanceof InvalidCursorError) {
        throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid page token' });
      }
      throw e;
    }
    // Feature 014 (R10): "show me what we missed" is a FILTER on the inbox, not a parallel endpoint —
    // so it inherits keyset paging, the page cap, the brand intersection and crm.inbox.view. An
    // unrecognised value is refused rather than ignored: silently dropping it would widen the query to
    // every conversation, which is the opposite of what the caller asked for (the 012 lesson).
    let idIn: string[] | undefined;
    const slaWire = req.slaOutcome;
    if (slaWire && slaWire !== 'SLA_OUTCOME_UNSPECIFIED') {
      // Feature 017 moved this map to `shared/wire.ts` — the export needs the same one, and a second
      // copy had already drifted (see that file).
      const outcome = wireToSlaOutcome(slaWire);
      if (!outcome) {
        throw new RpcException({
          code: GrpcStatus.INVALID_ARGUMENT,
          message: 'invalid sla_outcome',
        });
      }
      idIn = await this.sla.conversationIdsByOutcome(ctx.accountId, outcome);
    }

    // Feature 030 (roadmap 4.14): passed as a scope, so no filter the caller supplied can widen it — the
    // scope has no wire representation at all.
    const { rows, nextCursor } = await this.repo.list(ctx.accountId, {
      ...(portfolioIn ? { portfolioIn } : {}),
      // Feature 032: `undefined` = no status filter; `[]` = nothing satisfies the ask ⇒ an empty page.
      ...(statusIn === undefined ? {} : { statusIn }),
      priority: req.priority || undefined,
      assigneeOperatorId: req.assigneeOperatorId || undefined,
      // W5 (4.19): the rail's "he opened it" leg. A filter like any other — the WRITE is what is
      // self-scoped (see getConversation below), so the fact is trustworthy whoever asks about it.
      openedByOperatorId: req.openedByOperatorId || undefined,
      playerId: req.playerId || undefined,
      brandIn: resolveBrandIn(ctx, req.brandId),
      // '' means "no filter on channel", NOT "conversations that have no channel" — the rows with no
      // channel (~1 in 6 on the stand) stay reachable precisely by this being undefined.
      channel: req.channel || undefined,
      order,
      ...(idIn === undefined ? {} : { idIn }),
      limit: clampPageSize(req.pageSize),
      cursor,
    });
    return {
      conversations: rows.map(toSummaryWire),
      // The scope travels with the token, beside the order, so page two cannot resume into a portfolio
      // that has changed since page one (FR-014).
      nextPageToken: nextCursor
        ? encodeOrderedCursor({ ...nextCursor, ...(scopeFingerprint ? { scope: scopeFingerprint } : {}) })
        : '',
    };
  }

  @GrpcMethod('ChatsReadService', 'GetConversation')
  @RequiresChatsPermission('crm.inbox.view')
  async getConversation(req: GetConversationRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const row = await this.repo.getById(ctx.accountId, req.id);
    // Not in this account, or a brand the caller may not serve → identical NOT_FOUND (no existence
    // disclosure across tenants — spec Edge Cases).
    if (!row) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }
    /**
     * ⭐ Feature 030 (roadmap 4.14): the SAME scope on the detail path.
     *
     * ⚠️ A list-only narrowing is the defect shape roadmap 9.1 shipped — *the rail stopped rendering the
     * link and the route kept answering*. An id is guessable from a colleague's screen or a pasted URL,
     * so a queue narrowed only in the list is not narrowed.
     *
     * Refused as **NOT_FOUND**, identical to the cross-tenant answer above: *"outside your portfolio"*
     * and *"does not exist"* must be indistinguishable, or the refusal itself confirms the conversation
     * exists and names somebody else's customer by implication.
     */
    const portfolioIn = await this.portfolioScope(metadata);
    if (portfolioIn && !inPortfolio(row, portfolioIn)) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }

    /**
     * ── W5 (roadmap 4.19): opening a conversation IS the fact the agent rail stands on ─────────────
     *
     * Recorded only after every refusal above — a read that was denied did not happen. The subject is
     * the CALLER's resolved operator identity, never a request field: this is the one write that makes
     * the `opened_by_operator_id` filter a fact rather than a claim.
     *
     * ⚠️ Best-effort by construction. The caller asked for a conversation, and neither an unreachable
     * `users` (identity → null, no mark) nor a mark write failure may turn that answer into an error —
     * the next open simply tries again. And ⚠️ NOT under preview: view-as is read-only in effect, and
     * an owner walking through a role's screens must not stamp "opened" onto their own rail.
     */
    if (!ctx.underPreview) {
      const operatorId = await this.operatorIdentity.resolveCallerOperatorId(metadata);
      if (operatorId) {
        try {
          await this.readMarks.recordRead(ctx.accountId, req.id, operatorId);
        } catch {
          // The read proceeds; the mark is one open behind. Nothing to log beyond the class the
          // repository's own failure already carries.
        }
      }
    }

    // Feature 014: the first-reply measurement rides on the detail so the UI needs no second call.
    const sla = await this.sla.getState(ctx.accountId, req.id);
    return {
      ...toDetailWire(row),
      firstReplySla: sla
        ? {
            outcome: `SLA_OUTCOME_${sla.outcome.toUpperCase()}`,
            startedAt: sla.started_at.toISOString(),
            deadlineAt: sla.deadline_at.toISOString(),
            targetMinutes: sla.target_minutes,
            firstReplyAt: sla.first_reply_at ? sla.first_reply_at.toISOString() : '',
            firstReplySeconds: sla.first_reply_seconds ?? 0,
          }
        : undefined,
    };
  }

  /**
   * ⭐ W9 / spec 035 (ADR 0044 §4) — the lookup, gated by CONTEXT as well as by key. This proxy is
   * the ONLY route to the question "whose contact is this?":
   *
   *  · the conversation must exist, be the caller's, and be UNIDENTIFIED — a lookup from an
   *    identified ticket has no workflow reason and is exactly the browsing shape 0044 forbids;
   *  · users is dialled WITH THE CALLER'S OWN metadata (`lookupByContact` forwards it unchanged),
   *    so the permission, the audit entry and the rate cap all land on the real actor — a system
   *    actor here would launder the sharpest key in the product;
   *  · the conversation's own brand scopes the search; the caller cannot name another;
   *  · the RESTRICTED transition `contact.lookup_performed` is recorded on the conversation under
   *    the SAME hash the users-side audit entry carries — one token, two trails, correlatable.
   */
  @GrpcMethod('ChatsReadService', 'LookupContactForConversation')
  @RequiresChatsPermission('crm.contact.lookup')
  async lookupContactForConversation(
    req: { conversationId?: string; kind?: string; value?: string },
    metadata: Metadata,
  ) {
    const ctx = readActorContext(metadata);
    const conversationId = (req.conversationId ?? '').trim();
    const kind = req.kind === 'email' || req.kind === 'phone' ? req.kind : null;
    const value = (req.value ?? '').trim();
    if (!conversationId || !kind || !value) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'conversationId, kind (email|phone) and value are required',
      });
    }

    const conversation = await this.repo.getById(ctx.accountId, conversationId);
    if (!conversation) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    if (conversation.identity_state === 'identified') {
      throw new RpcException({
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'conversation already identified',
      });
    }

    let res;
    try {
      res = await this.person.lookupByContact(
        { brandId: conversation.brand_id, kind, value },
        metadata,
      );
    } catch (err) {
      // Status preserved (403 stays 403, RESOURCE_EXHAUSTED stays itself); message never from
      // downstream (SEC-26).
      throw toPersonRpc(err);
    }

    // The conversation-side half of the trail. Written AFTER the users call succeeded — a refused
    // or capped attempt is already recorded there, on the real actor, and a second row here would
    // double-count every attempt an investigator tallies.
    const before = await this.repo.transitionBeforeOf(ctx.accountId, conversationId);
    if (before) {
      await this.transitions.record(
        this.prisma.forAccount(ctx.accountId) as never,
        lookupPerformed(
          ctx.accountId,
          before,
          {
            valueHash: res.valueHash,
            valueKind: kind,
            matched: res.matched ? 'found' : res.ambiguous ? 'ambiguous' : 'none',
          },
          userActor(ctx.userId),
          new Date(),
          metadata,
        ),
      );
    }

    return {
      matched: res.matched,
      ambiguous: res.ambiguous,
      playerId: res.playerId,
      brandId: res.brandId,
    };
  }
}
