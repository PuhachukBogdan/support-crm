import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext, resolveBrandIn } from '../security/actor-context';
import {
  clampPageSize,
  decodeOrderedCursor,
  encodeOrderedCursor,
  InvalidCursorError,
} from '../shared/cursor';
import {
  toSummaryWire,
  toDetailWire,
  wireToStatus,
  wireToSlaOutcome,
  wireToConversationOrder,
} from '../shared/wire';
import { SlaRepository } from '../sla/sla.repository';
import {
  ConversationRepository,
  DEFAULT_INBOX_ORDER,
  isConversationOrderKey,
} from './conversation.repository';

// proto-loader (keepCase:false) delivers camelCase request objects.
interface ListConversationsRequestWire {
  status?: string;
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
  ) {}

  @GrpcMethod('ChatsReadService', 'ListConversations')
  @RequiresChatsPermission('crm.inbox.view')
  async listConversations(req: ListConversationsRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);

    // Feature 029 — the order is resolved FIRST, because the page token is validated against it.
    // An unrecognised order is refused, never coerced to the default: a list silently in a different
    // order than the caller asked for is the confidently-wrong-answer shape (the 012 lesson).
    const orderWire = wireToConversationOrder(req.order);
    if (orderWire === null || (orderWire !== undefined && !isConversationOrderKey(orderWire))) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid order' });
    }
    const order = orderWire ?? DEFAULT_INBOX_ORDER;

    let cursor;
    try {
      // ⭐ The token must have been minted under THIS order (research R8). Replaying one from the other
      // order would decode fine and then page a different sequence — a plausible list with rows
      // missing, invisible to whoever is reading it.
      cursor = decodeOrderedCursor(req.pageToken, order);
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

    const { rows, nextCursor } = await this.repo.list(ctx.accountId, {
      status: wireToStatus(req.status),
      priority: req.priority || undefined,
      assigneeOperatorId: req.assigneeOperatorId || undefined,
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
      nextPageToken: nextCursor ? encodeOrderedCursor(nextCursor) : '',
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
}
