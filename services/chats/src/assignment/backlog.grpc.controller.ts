import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { readActorContext } from '../security/actor-context';
import { BacklogRepository, firstServable, servesChannel } from './backlog';
import { GroupPoolService } from './group-pool';
import { RoundRobinStateRepository } from './round-robin-state.repository';

/**
 * Draining the backlog (feature 031, roadmap 4.20 / ADR 0042 §2).
 *
 * ── Why a maintenance rpc and not a timer ───────────────────────────────────────────────────────
 * Every periodic job in this service is a **worker-called rpc** on `ChatsMaintenanceService` — the SLA
 * sweep and the export runner both are. An in-process interval would make the drain fire once per
 * replica, which is a different number on every deployment and unobservable from outside.
 *
 * ── ⚠️ Counts only, never ids ───────────────────────────────────────────────────────────────────
 * A drain that returned conversation ids would put customer work into a maintenance response that gets
 * read, logged and graphed by people who are not looking at it with customer eyes (Principle IV). The
 * skipped count is the useful signal on its own: **high `skipped` with `assigned` at zero is the
 * head-of-line condition**, and that is diagnosable without naming anybody.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────────────────────────
 * ⛔ It does not let anybody choose. There is no rpc and no route by which an agent takes a queued item
 * (`no-backlog-take-path-031.spec.ts` proves the absence rather than a refusal). The drain is the only
 * thing that moves work out of the queue, and it moves the first item the freed capacity can serve.
 */
@Controller()
export class BacklogMaintenanceController {
  constructor(
    @Inject(BacklogRepository) private readonly backlog: BacklogRepository,
    @Inject(GroupPoolService) private readonly pool: GroupPoolService,
    @Inject(RoundRobinStateRepository) private readonly rotation: RoundRobinStateRepository,
  ) {}

  @GrpcMethod('ChatsMaintenanceService', 'DrainBacklog')
  async drainBacklog(req: { limit?: number }, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    // Server-capped, like every other maintenance batch: a caller cannot ask for the whole queue.
    const limit = Math.min(Math.max(Number(req?.limit ?? 0) || 25, 1), 100);

    const waiting = await this.backlog.waiting(ctx.accountId, limit);
    let assigned = 0;
    let skipped = 0;
    let unroutable = 0;

    for (const item of waiting) {
      /**
       * ⚠️ Capacity is re-read for EVERY item, not once for the batch.
       *
       * The first assignment in this loop consumes a unit, so a batch-level snapshot would hand the same
       * free slot to several conversations — the over-allocation R8 exists to prevent, arriving through
       * the back door of a cached pool.
       */
      const desk = await this.pool.candidatesFor(
        ctx.accountId,
        item.routed_group_id ?? '',
        metadata,
        item.channel,
        item.brand_id,
      );

      if (desk.reason) {
        // The desk is not a queue, or its staffing is unknown. Either way nobody can take this item now;
        // it keeps its place and its own reason is already recorded by the pool.
        unroutable += 1;
        continue;
      }

      const servable = firstServable([item], (channel) =>
        desk.candidates.some((c) =>
          servesChannel(channel, Math.max(0, c.capacity - c.currentLoad), c.currentLoad === 0),
        ),
      );
      if (!servable.pick) {
        // ⚠️ Passed over, and NOTHING about it is rewritten — that is what keeps its place (FR-008).
        skipped += 1;
        continue;
      }

      const { operatorId } = await this.rotation.selectAndAssign(
        ctx.accountId,
        item.id,
        item.routed_group_id || 'default',
        desk.candidates,
        item.routed_group_id || undefined,
      );
      if (operatorId === null) {
        // It fitted a moment ago and does not now — somebody else took the slot. Not an error: the item
        // stays queued and the next drain tries again.
        skipped += 1;
        continue;
      }

      await this.backlog.dequeue(ctx.accountId, item.id);
      assigned += 1;
    }

    return { considered: waiting.length, assigned, skipped, unroutable };
  }
}
