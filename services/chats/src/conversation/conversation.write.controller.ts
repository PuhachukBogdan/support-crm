import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { userActor } from '../transition/conversation-transitions';
import { toDetailWire } from '../shared/wire';
import { MAX_SUBJECT_LENGTH } from '../subject/subject.derive';
import { DomainEventPublisher } from '../events/events.publisher';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { StatusRepository } from '../status/status.repository';
import { AuditRepository } from '../audit/audit.repository';
import { ConversationRepository } from './conversation.repository';

interface CreateConversationRequestWire {
  brandId: string;
  playerId?: string;
  priority?: string;
  channel?: string;
  assigneeOperatorId?: string;
}
interface SetConversationStatusRequestWire {
  conversationId: string;
  /**
   * ⚠️ Feature 032: the legacy `status` enum field is NOT read. Declared here so a reader of this file
   * knows that omission is deliberate — a caller sending only it gets `invalid status`, because guessing
   * which of nine configured statuses `CONVERSATION_STATUS_PENDING` meant is worse than refusing.
   */
  status?: string;
  statusKey?: string;
}
interface SetConversationBrandRequestWire {
  conversationId: string;
  brandId?: string;
}
interface SetConversationSubjectRequestWire {
  conversationId: string;
  subject?: string;
}

/**
 * ChatsWriteService — conversation writes (feature 012, US1). `CreateConversation` seeds/tests +
 * future channel ingress; `SetConversationStatus` is the 4.1 lifecycle change. Gated by
 * `crm.conversation.reply` at both tiers; account scope via `forAccount`; brand resource-checked (R3).
 *
 * Feature 014 publishes `conversation.created` and `conversation.status_changed` from here. Publishing
 * sits at the controller and nowhere else, so an automation's own status write emits nothing and
 * cannot cascade (FR-006 / research R4) — a self-satisfying rule is bounded by construction.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class ConversationWriteController {
  constructor(
    @Inject(ConversationRepository) private readonly repo: ConversationRepository,
    @Inject(DomainEventPublisher) private readonly events: DomainEventPublisher,
    @Inject(StatusRepository) private readonly statuses: StatusRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
    // Feature 034 (W4). ⚠️ A DIFFERENT thing from `events` above: that one is the in-process automation
    // trigger, this one tells browsers a read is worth doing. They are published from the same places and
    // must not be conflated — one can cascade into rules, the other has no server-side subscriber at all.
    @Inject(RealtimePublisher) private readonly realtime: RealtimePublisher,
  ) {}

  @GrpcMethod('ChatsWriteService', 'CreateConversation')
  @RequiresChatsPermission('crm.conversation.reply')
  async createConversation(req: CreateConversationRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    if (!req.brandId) {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    const row = await this.repo.create(ctx.accountId, {
      brandId: req.brandId,
      playerId: req.playerId || undefined,
      priority: req.priority || undefined,
      channel: req.channel || undefined,
      assigneeOperatorId: req.assigneeOperatorId || undefined,
    });
    await this.events.conversationCreated(ctx.accountId, row.id);
    /**
     * Feature 034 (W4): tell the account's sockets a ticket exists. **After the automation trigger
     * above**, on purpose — a rule may have just changed the status, and one event that lands on the
     * final state is better than two events racing to describe an intermediate one.
     */
    await this.realtime.conversation('conversation.created', ctx.accountId, row.id);
    // Re-read: a rule may have changed status/priority/assignee, and the caller should see the
    // conversation as it actually is now rather than as it was a moment before the rules ran.
    const fresh = await this.repo.getById(ctx.accountId, row.id);
    return toDetailWire(fresh ?? row);
  }

  @GrpcMethod('ChatsWriteService', 'SetConversationStatus')
  @RequiresChatsPermission('crm.conversation.reply')
  async setConversationStatus(req: SetConversationStatusRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    /**
     * ⭐ Feature 032 (roadmap 4.16): validated against the ACCOUNT's active statuses, not against a
     * vocabulary in code. Unknown and retired are the same refusal on purpose — "may I still set
     * Follow-up?" must not have two different answers depending on who is asking.
     *
     * The resolve happens BEFORE the conversation is read, so an invalid key never causes a lookup of
     * somebody's ticket, and the refusal names no status of ours back to the caller.
     */
    const target = await this.statuses.resolveActive(ctx.accountId, req.statusKey ?? '');
    if (!target) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid status' });
    }
    // Resource-check the target's brand before mutating (no existence disclosure otherwise).
    const existing = await this.repo.getById(ctx.accountId, req.conversationId);
    if (!existing) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }
    const newStatus = target.key;
    // Feature 023: the human who did it, and one correlation id for this act. Note the deliberate
    // ordering below — the durable TRANSITION is written inside `setStatus`'s own transaction, while
    // `this.events.statusChanged` further down is the in-process automation trigger (feature 014),
    // which is a different thing entirely and is fire-and-observe rather than durable.
    const updated = await this.repo.setStatus(
      ctx.accountId,
      req.conversationId,
      newStatus,
      userActor(ctx.userId),
      metadata,
    );
    if (!updated) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    await this.events.statusChanged(
      ctx.accountId,
      req.conversationId,
      newStatus,
      updated.updated_at,
    );
    // Feature 034 (W4): a status change is what moves a row BETWEEN the Inbox's filtered views. Without
    // this, a ticket appears live and then wrongly stays where it no longer belongs.
    await this.realtime.conversation('conversation.updated', ctx.accountId, req.conversationId);
    const fresh = await this.repo.getById(ctx.accountId, req.conversationId);
    return toDetailWire(fresh ?? updated);
  }

  /**
   * ⭐ The one field an agent may NOT change (feature 032, roadmap 4.16 — R22, amends ADR 0038).
   *
   * ── A permission of its own, and not `crm.conversation.reply` ────────────────────────────────────
   * Everything else on this controller is an everyday act by whoever handles the ticket. Brand decides
   * which reports the conversation appears in and whose history it becomes part of, and the operator's
   * rule is explicit: set at ingestion, chosen when a ticket is raised by hand, **read-only for agents**,
   * corrigible by a supervisor. So `crm.conversation.set_brand` — one key per scope, the precedent
   * 017/024/025 set — held by `teamlead`, `admin` and `super_admin`, and by no agent role.
   *
   * ⚠️ Brand is NOT an authorization wall (ADR 0038 §1): nobody is refused a conversation because of its
   * brand, and this key does not change that. It gates the WRITE only.
   *
   * ── Refused when nothing would change ───────────────────────────────────────────────────────────
   * Setting the brand it already has is INVALID_ARGUMENT rather than a silent success. The audit entry is
   * the point of this handler, and an entry that records no change is noise in the store that exists to
   * be read — the same reasoning that keeps a `Pending → Pending` toggle out of the audit catalogue.
   *
   * ── The detail carries REFS, never names ────────────────────────────────────────────────────────
   * `fromBrandRef` / `toBrandRef` are ids. A brand's NAME lives in the brands service, and copying it
   * here would make this trail store state instead of referencing it (feature 015: *"target_ref
   * identifies, never copies"*).
   */
  @GrpcMethod('ChatsWriteService', 'SetConversationBrand')
  @RequiresChatsPermission('crm.conversation.set_brand')
  async setConversationBrand(req: SetConversationBrandRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const brandId = (req.brandId ?? '').trim();
    if (!brandId) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid brand' });
    }

    // Read first: `updateMany` reports 0 for an id that is not there and the transaction still commits,
    // so an unchecked call would file an entry for a change that never happened (see `setBrand`).
    const existing = await this.repo.getById(ctx.accountId, req.conversationId);
    if (!existing) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }
    if (existing.brand_id === brandId) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'brand unchanged' });
    }

    // Built here, so a detail that cannot be expressed refuses the ACTION rather than being rolled back.
    const statement = this.audit.statement(ctx.accountId, {
      actorUserId: ctx.userId,
      actorKind: 'user',
      underPreview: ctx.underPreview,
      action: 'conversation.brand_changed',
      targetRef: req.conversationId,
      detail: { fromBrandRef: existing.brand_id, toBrandRef: brandId },
    });

    const count = await this.repo.setBrand(ctx.accountId, req.conversationId, brandId, statement);
    if (count === 0) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

    const fresh = await this.repo.getById(ctx.accountId, req.conversationId);
    if (!fresh) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    return toDetailWire(fresh);
  }

  /**
   * ⭐ W9 / spec 035 (ADR 0044 §5) — attach the conversation to a player. Gated by the SAME key as
   * the lookup (`crm.contact.lookup`): confirming a match and recording it are one capability, and
   * a key that allowed searching but not attaching would push the attach into support tickets.
   *
   * Refusals before any write: not found; ALREADY IDENTIFIED (detach first — a silent overwrite
   * would orphan the previous identity's window without a detach event to close it). The brand is
   * NOT a parameter: the player must exist under the conversation's own brand — the lookup that
   * produced this id was scoped to it, and a request field would allow attaching across brands.
   */
  @GrpcMethod('ChatsWriteService', 'SetConversationPlayer')
  @RequiresChatsPermission('crm.contact.lookup')
  async setConversationPlayer(
    req: { conversationId?: string; playerId?: string },
    metadata: Metadata,
  ) {
    const ctx = readActorContext(metadata);
    const playerId = (req.playerId ?? '').trim();
    const conversationId = (req.conversationId ?? '').trim();
    if (!playerId || !conversationId) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'conversationId and playerId are required' });
    }

    const existing = await this.repo.getById(ctx.accountId, conversationId);
    if (!existing) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    if (existing.identity_state === 'identified') {
      throw new RpcException({ code: GrpcStatus.FAILED_PRECONDITION, message: 'already identified — detach first' });
    }

    const statement = this.audit.statement(ctx.accountId, {
      actorUserId: ctx.userId,
      actorKind: 'user',
      underPreview: ctx.underPreview,
      action: 'conversation.player_attach',
      targetRef: conversationId,
      // The PAIR, as ids: a bare player id names two customers (the 07-29 Person repair).
      detail: { playerRef: playerId, brandRef: existing.brand_id },
    });

    const before = await this.repo.transitionBeforeOf(ctx.accountId, conversationId);
    if (!before) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    const count = await this.repo.setPlayer(
      ctx.accountId,
      before,
      playerId,
      userActor(ctx.userId),
      statement,
      metadata,
    );
    if (count === 0) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

    // Whose ticket this is just changed — exactly what the Inbox and the open window render.
    await this.realtime.conversation('conversation.updated', ctx.accountId, conversationId);

    const fresh = await this.repo.getById(ctx.accountId, conversationId);
    if (!fresh) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    return toDetailWire(fresh);
  }

  /**
   * The reverse — and the response IS the warning (0044 §5's hazard): what staff wrote while this
   * player was attached stays where it was written, so the counts travel back for the UI to show
   * BEFORE the person confirms. The counts are computed before the detach; the transition inside
   * the same transaction is what closes the window for the NEXT computation.
   */
  @GrpcMethod('ChatsWriteService', 'DetachConversationPlayer')
  @RequiresChatsPermission('crm.contact.lookup')
  async detachConversationPlayer(req: { conversationId?: string }, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const conversationId = (req.conversationId ?? '').trim();
    if (!conversationId) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'conversationId is required' });
    }

    const existing = await this.repo.getById(ctx.accountId, conversationId);
    if (!existing) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    const detachedPlayerId = (existing.player_id ?? '').trim();
    if (existing.identity_state !== 'identified' || detachedPlayerId === '') {
      throw new RpcException({ code: GrpcStatus.FAILED_PRECONDITION, message: 'nothing attached' });
    }

    const harvest = await this.repo.staffWritesSinceAttach(ctx.accountId, conversationId);

    const statement = this.audit.statement(ctx.accountId, {
      actorUserId: ctx.userId,
      actorKind: 'user',
      underPreview: ctx.underPreview,
      action: 'conversation.player_detach',
      targetRef: conversationId,
      detail: { playerRef: detachedPlayerId, brandRef: existing.brand_id },
    });

    const before = await this.repo.transitionBeforeOf(ctx.accountId, conversationId);
    if (!before) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    const count = await this.repo.detachPlayer(
      ctx.accountId,
      before,
      detachedPlayerId,
      userActor(ctx.userId),
      statement,
      metadata,
    );
    if (count === 0) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

    await this.realtime.conversation('conversation.updated', ctx.accountId, conversationId);

    return {
      detachedPlayerId,
      publicReplies: harvest.publicReplies,
      privateNotes: harvest.privateNotes,
    };
  }

  /**
   * A person names the conversation, and that LOCKS the title (feature 023, roadmap 4.18 — FR-022).
   *
   * ── No new permission key, deliberately ─────────────────────────────────────────────────────────
   * `crm.conversation.reply` already governs changing this conversation, and naming it is not a new
   * kind of authority — it exposes nothing, deletes nothing and changes no privilege. A key that gated
   * one field would be a key nobody remembers to assign, and the closed catalogue (ADR 0011) exists so
   * that adding one is a deliberate act rather than a reflex.
   *
   * ── No audit entry either, and the difficulty of placing one was the signal ─────────────────────
   * This was first drafted as an audit action, and then no honest class existed for it among
   * privilege / deletion / access / export / assignment / retention. ADR 0019 records SENSITIVE
   * actions; a title edit is a state change with an actor and a time, which is what the transition
   * store is for. One transition, no new audit class (data-model §4).
   *
   * ── Refused, not truncated ──────────────────────────────────────────────────────────────────────
   * An over-long title is an INVALID_ARGUMENT. Silently shortening it would store words the author did
   * not write, with no way for them to tell — and the derivation truncates only because a customer's
   * 4 000-character message was never meant as a title in the first place.
   */
  @GrpcMethod('ChatsWriteService', 'SetConversationSubject')
  @RequiresChatsPermission('crm.conversation.reply')
  async setConversationSubject(req: SetConversationSubjectRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);

    const subject = (req.subject ?? '').replace(/\s+/gu, ' ').trim();
    if (!subject) {
      // Clearing a title is not an operation this offers: a conversation with a human-set title and no
      // text would be frozen at nothing, and the automated writers could never fill it again.
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid subject' });
    }
    if (subject.length > MAX_SUBJECT_LENGTH) {
      // Length only — the offending value is a human's words and never enters a message or a log.
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'subject too long' });
    }

    // Resource-check the target's brand before mutating (no existence disclosure otherwise), exactly
    // as the status write above does.
    const existing = await this.repo.getById(ctx.accountId, req.conversationId);
    if (!existing) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }

    const updated = await this.repo.setSubject(
      ctx.accountId,
      req.conversationId,
      subject,
      userActor(ctx.userId),
      metadata,
    );
    if (!updated) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

    // No `this.events.*` here: a title is a label for humans, not a trigger. Publishing it would let a
    // rule react to a rename, which is the cascade feature 014 bounded by construction.
    return toDetailWire(updated);
  }
}
