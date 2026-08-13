import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { toDetailWire } from '../shared/wire';
import { ConversationRepository } from '../conversation/conversation.repository';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { RoundRobinStateRepository } from './round-robin-state.repository';
import { GroupPoolService } from './group-pool';
import { BacklogRepository } from './backlog';
import type { RoundRobinCandidate } from './round-robin';

interface AutoAssignRequestWire {
  conversationId?: string;
  groupKey?: string;
  candidates?: { operatorId?: string; capacity?: number; currentLoad?: number }[];
  /** Feature 024 (roadmap 5.3): name a group and the service builds the pool. */
  groupId?: string;
}

/** Machine-readable reasons for a non-assignment (spec US3 #3/#4). */
export const NO_OPERATOR_AVAILABLE = 'NO_OPERATOR_AVAILABLE';
export const GROUP_ROUTING_NOT_AVAILABLE = 'GROUP_ROUTING_NOT_AVAILABLE';

/**
 * ChatsWriteService — round-robin auto-assignment (feature 013, US3 / roadmap 4.4). Same permission
 * as manual assignment (`crm.conversation.assign`) at both tiers.
 *
 * ── Two ways to name a pool (feature 024, roadmap 5.3 — ADR 0039 §5.3) ──────────────────────────
 *
 * `group_id` — the service resolves the pool itself: membership from auth, operator profiles from
 * users, current load counted here, capacity from a 🅿 provisional configured default. This is the
 * source the handler had been waiting for since feature 013.
 *
 * `candidates` — the original caller-supplied list, **unchanged**. Feature 024 added a source; it
 * removed nothing.
 *
 * ⚠️ **`group_id` WINS and `candidates` is then ignored.** Merging the two would make a routing
 * decision unexplainable — "which of the two did it use?" is not a question anyone should have to ask
 * of a live queue. And `GROUP_ROUTING_NOT_AVAILABLE` survives verbatim for a pool that resolves to
 * nobody: a guess is worse than an honest "not yet" (US3 #4), which was true when there was no source
 * and is still true now that there is one.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class AutoAssignController {
  constructor(
    @Inject(RoundRobinStateRepository) private readonly rotation: RoundRobinStateRepository,
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
    @Inject(GroupPoolService) private readonly pool: GroupPoolService,
    @Inject(BacklogRepository) private readonly backlog: BacklogRepository,
    // W5: whose queue a ticket is in is exactly what the Inbox renders, so it must move by itself.
    @Inject(RealtimePublisher) private readonly realtime: RealtimePublisher,
  ) {}

  @GrpcMethod('ChatsWriteService', 'AutoAssignConversation')
  @RequiresChatsPermission('crm.conversation.assign')
  async autoAssignConversation(req: AutoAssignRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const conversationId = (req.conversationId ?? '').trim();
    if (!conversationId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'conversation_id is required',
      });
    }

    // Resource-check the target before anything else (no existence disclosure).
    const conversation = await this.conversations.getById(ctx.accountId, conversationId);
    if (!conversation) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }

    // Feature 024: a named group wins outright. `candidates` is not merged in — see the header.
    const groupId = (req.groupId ?? '').trim();
    // Feature 031: the pool now answers WHY it is empty when it is, because "this desk is not a queue"
    // and "nobody staffs this desk" send an administrator to different places.
    const pooled = groupId
      ? // Feature 025 (roadmap 5.9): the conversation's own channel decides whether a per-channel
        // switch applies. `null` when it was never recorded — feature 022 keeps that case distinct
        // from every channel NAME, and the availability predicate answers it at state level alone
        // rather than matching it against a switch.
        await this.pool.candidatesFor(
          ctx.accountId,
          groupId,
          metadata,
          conversation.channel ?? null,
          // Feature 031: the budget is per brand, so the conversation's own brand decides it.
          conversation.brand_id ?? null,
        )
      : null;

    if (pooled?.reason) {
      return { assigned: false, operatorId: '', reason: pooled.reason };
    }

    const candidates: RoundRobinCandidate[] = pooled
      ? pooled.candidates
      : (req.candidates ?? [])
          .map((c) => ({
            operatorId: (c?.operatorId ?? '').trim(),
            capacity: Number(c?.capacity ?? 0),
            currentLoad: Number(c?.currentLoad ?? 0),
          }))
          .filter((c) => c.operatorId !== '');

    // Nobody to route to. Two different situations, one honest answer: no candidate set was supplied
    // at all, or the named group has no assignable member. Neither is a reason to guess.
    //
    // ⚠️ This is NOT the "auth or users is unreachable" case. Those RAISE inside `candidatesFor` and
    // never arrive here as an empty pool — if they did, an outage would look exactly like an empty
    // desk and routing would stop for a whole team with every request still answering 200.
    if (candidates.length === 0) {
      /**
       * ⭐ Feature 031: a NAMED DESK with nobody available right now means the work WAITS.
       *
       * ⚠️ Found on the live run, and it is the everyday case rather than an edge: "everyone is full" is
       * rarer than "nobody is at this desk at this minute" — a shift gap, a lunch hour, a night. Before
       * this, that work was left unowned with no record that it was waiting and no retry, which is exactly
       * the failure the queue exists to prevent. The over-capacity path was queued and this one was not,
       * so the queue covered the rarer half of the problem.
       *
       * ⓘ Only when a desk was NAMED. With a caller-supplied candidate list there is no desk to retry
       * against, so queueing would produce work the drain can only report as `no_desk` for ever.
       *
       * ⚠️ The reason code is unchanged: callers already handle it and it is still true.
       */
      if (groupId) await this.backlog.enqueue(ctx.accountId, conversationId, new Date(), groupId);
      return {
        assigned: false,
        operatorId: '',
        reason: GROUP_ROUTING_NOT_AVAILABLE,
      };
    }

    // The rotation is keyed per pool. A named group keys on its id, so two desks rotate independently
    // and neither can advance the other's cursor.
    const groupKey = groupId || (req.groupKey ?? '').trim() || 'default';
    const { operatorId } = await this.rotation.selectAndAssign(
      ctx.accountId,
      conversationId,
      groupKey,
      candidates,
      groupId || undefined,
    );

    // Everyone at capacity: the conversation stays as it was — never assigned to an over-capacity
    // operator just to have an answer (spec US3 #3).
    if (operatorId === null) {
      /**
       * ⭐ Feature 031 (roadmap 4.20): everyone is full, so the work WAITS instead of staying unowned.
       *
       * Before this, the answer was `NO_OPERATOR_AVAILABLE` and — in this file's own previous words —
       * *"the conversation stays as it was"*: nothing recorded that it was waiting, in what order, or that
       * it should be retried. That is the failure a queue exists to prevent.
       *
       * ⚠️ The reason code is UNCHANGED on purpose. Callers already handle it, and "nobody has room right
       * now" is still the truth; what changed is that the conversation is now in a queue that will drain.
       */
      // ⚠️ The DESK travels with it. Without this the queue is undrainable: `routed_group_id` is
      // written by the assignment, so work that never got an owner recorded no desk and the drain had
      // no pool to resolve. Found on the first live run, one row into the first tick.
      await this.backlog.enqueue(ctx.accountId, conversationId, new Date(), groupId || undefined);
      return { assigned: false, operatorId: '', reason: NO_OPERATOR_AVAILABLE };
    }

    // It has an owner now, so it is no longer waiting. Cleared here rather than inside the rotation's
    // transaction because it is true for EVERY route to an owner, not only this one (FR-010).
    await this.backlog.dequeue(ctx.accountId, conversationId);

    // W5: after the commit, best-effort by the publisher's own contract (it never throws).
    await this.realtime.conversation('conversation.updated', ctx.accountId, conversationId);

    const updated = await this.conversations.getById(ctx.accountId, conversationId);
    return {
      assigned: true,
      operatorId,
      reason: '',
      ...(updated ? { conversation: toDetailWire(updated) } : {}),
    };
  }
}
