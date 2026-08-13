import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { Metadata, type MetadataValue } from '@grpc/grpc-js';
import { BacklogRepository, firstServable, servesChannel } from './backlog';
import { BacklogSweepRepository, type WaitingConversation } from './backlog-sweep.repository';
import { GroupPoolService } from './group-pool';
import { RoundRobinStateRepository } from './round-robin-state.repository';
import { AuditRepository } from '../audit/audit.repository';

/**
 * Draining the backlog (feature 031, roadmap 4.20 / ADR 0042 §2).
 *
 * ── Why a maintenance rpc and not a timer ───────────────────────────────────────────────────────
 * Every periodic job in this service is a **worker-called rpc** on `ChatsMaintenanceService` — the SLA
 * sweep and the export runner both are. An in-process interval would make the drain fire once per
 * replica, which is a different number on every deployment and unobservable from outside.
 *
 * ── ⭐ THE CALLER HAS NO ACCOUNT, and the first version of this file assumed it did ─────────────
 * It read `readActorContext(metadata)` for an account id. Every hermetic test supplied one; the worker
 * cannot, because a tick belongs to no tenant. Live, the drain therefore threw `PERMISSION_DENIED`
 * twelve times a minute and the queue never moved — and **a queue that never drains looks exactly like
 * a queue with nothing in it**, so the only symptom was a log line saying `backlog drain failed: Error`
 * in a service nobody was reading.
 *
 * ⇒ It now has the shape the SLA sweep already had: **one unscoped step choosing which accounts have
 * work** (`BacklogSweepRepository`), then everything else per account through `forAccount`. The account
 * comes from the ROW, never from the caller.
 *
 * ── ⚠️ System actor only ────────────────────────────────────────────────────────────────────────
 * A user session must never reach a cross-account path, even a counts-only one (feature 014's rule for
 * the SLA sweep). The first version had no actor check at all: it was scoped to whoever called it, so
 * the check was implicit in `readActorContext`. Now that the account comes from the data, the gate has
 * to be explicit.
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
    @Inject(BacklogSweepRepository) private readonly sweep: BacklogSweepRepository,
    @Inject(GroupPoolService) private readonly pool: GroupPoolService,
    @Inject(RoundRobinStateRepository) private readonly rotation: RoundRobinStateRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  @GrpcMethod('ChatsMaintenanceService', 'DrainBacklog')
  async drainBacklog(req: { limit?: number }, metadata: Metadata) {
    if (readMeta(metadata, 'x-actor-kind') !== 'system') {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    // Server-capped, like every other maintenance batch: a caller cannot ask for the whole queue.
    const limit = Math.min(Math.max(Number(req?.limit ?? 0) || 25, 1), 100);

    const waiting = await this.sweep.waitingAcrossAccounts(limit);
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
        item.account_id,
        item.routed_group_id ?? '',
        // ⚠️ Metadata built PER ACCOUNT from the row, not forwarded from the caller: the caller has no
        // account, and the downstream reads (desk membership, operator profiles) each need one. The
        // actor kind travels with it so the users side can tell a machine from a person — a system
        // caller must not be able to borrow a human's permissions (the `ListPersonMembers` rule).
        systemMetadataFor(item.account_id),
        item.channel,
        item.brand_id,
      );

      if (desk.reason) {
        /**
         * ⭐ Work that can reach NOBODY (ADR 0042 §5, FR-022). Recorded as an **audited event**, and the
         * conversation keeps its place in the queue.
         *
         * ⚠️ **An event and not a notification, deliberately** (research R7/D-5): there is no alerting
         * surface in this product, and an alarm with no consumer is the defect that shipped once already
         * when the audit log ran for five features with no screen. 9.18 is its future reader, and the fact
         * is on record now rather than shouted into a log nothing collects.
         *
         * ⚠️ **A reason CLASS, never a sentence and never the customer.** The class is what an
         * administrator can act on — *the desk is not a queue* is a checkbox, *nobody is available* is a
         * rota — and it carries no contact value by construction.
         */
        unroutable += 1;
        await this.audit.append(item.account_id, {
          action: 'conversation.unroutable',
          actorKind: 'system',
          actorRef: 'backlog-drain',
          accountId: item.account_id,
          targetRef: item.id,
          detail: {
            reasonClass: desk.reason === 'DESK_NOT_ROUTABLE' ? 'desk_not_routable' : 'nobody_available',
          },
        } as never);
        continue;
      }

      const servable = firstServable([toItem(item)], (channel) =>
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
        item.account_id,
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

      await this.backlog.dequeue(item.account_id, item.id);
      assigned += 1;
    }

    return { considered: waiting.length, assigned, skipped, unroutable };
  }
}

function readMeta(md: Metadata | undefined, key: string): string {
  const raw: MetadataValue | undefined = md?.get?.(key)?.[0];
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') return (raw as Buffer).toString('utf8');
  return '';
}

/**
 * The metadata the drain presents to the services it consults, for ONE account.
 *
 * ⛔ It carries no permissions and never will. A machine that granted itself
 * `crm.conversation.assign` would be laundering a human's permission, which is exactly what the users
 * service refuses to accept — so the downstream reads a machine needs live on machine-only surfaces
 * (`UsersMaintenanceService`), gated on this same actor kind.
 */
function systemMetadataFor(accountId: string): Metadata {
  const md = new Metadata();
  md.set('x-actor-kind', 'system');
  md.set('x-actor-account-id', accountId);
  return md;
}

/** The sweep row, as the pure queue helpers want it. */
function toItem(row: WaitingConversation) {
  return {
    id: row.id,
    channel: row.channel,
    brand_id: row.brand_id,
    routed_group_id: row.routed_group_id,
    backlog_at: row.backlog_at,
  };
}
