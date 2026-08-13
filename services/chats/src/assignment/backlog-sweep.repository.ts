import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE SECOND UNSCOPED TENANT READ IN THIS SERVICE. Read this, and `sla/sla-sweep.repository.ts`,
 * before changing anything here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Feature 031 (roadmap 4.20). ⭐ **Found on the FIRST LIVE RUN**, not in design: the drain was written
 * to take its account from `readActorContext(metadata)`, and every hermetic test supplied one. In
 * production the caller is the worker's tick, which has no account and cannot have one — so the drain
 * threw `PERMISSION_DENIED` on every tick and the queue never drained. The worker logged
 * `backlog drain failed: Error` twelve times a minute and nothing else noticed, because a queue that
 * does not drain looks exactly like a queue with nothing in it.
 *
 * ── Why it has to exist ─────────────────────────────────────────────────────────────────────────
 * A timer has no caller, therefore no account, and `forAccount()` throws without one — by design. But
 * waiting work is precisely what nobody is looking at: no request is open, and the person who would
 * have noticed is the one who is full. Answering *"which accounts have work waiting"* cannot be asked
 * through a per-account client.
 *
 * ── Why it is judged compliant with Principle I ─────────────────────────────────────────────────
 * Identical five-way argument to the SLA sweep, and each point is checked by a test:
 *
 *   1. **Ids only.** The `select` is the id, the account, and what routing arithmetic needs — channel,
 *      brand, desk, and the two timestamps. No subject, no player, no body (Principle IV).
 *   2. **Nothing leaves the service.** `DrainBacklog` answers with COUNTS, never rows, even for a
 *      system caller.
 *   3. **No caller can reach it.** Only `ChatsMaintenanceService.DrainBacklog` calls it; that handler
 *      requires `x-actor-kind: system` and has no gateway route.
 *   4. **Every write stays scoped.** This step chooses *which* accounts have work; the assignment, the
 *      dequeue and the audit entry all run through `forAccount(accountId)`.
 *   5. **Bounded.** The limit is server-capped, so one tick cannot scan the world.
 *
 * ⓘ The raw `this` client is the audited escape hatch `PrismaService` documents; `forAccount()` cannot
 * express this question, which is the whole reason the hatch exists — and the reason the SLA sweep uses
 * it the same way, one file over.
 *
 * ── ⚠️ Two copies, and why there is not a third ─────────────────────────────────────────────────
 * The SLA sweep's file says *"do not add anything else to this file — its value is that it is exactly
 * one method, easy to audit in full."* So this is a sibling rather than a second method there. Two
 * files with a pointer in each is reviewable; a third would be a convention, and at that point the
 * unscoped read needs a single audited primitive instead of a growing family.
 */

/** One waiting conversation, identified only enough to route it under its own account scope. */
export interface WaitingConversation {
  account_id: string;
  id: string;
  channel: string | null;
  brand_id: string;
  routed_group_id: string | null;
  backlog_at: Date;
  /** Set once the drain has recorded that this work can reach nobody; null while it can. */
  unroutable_since: Date | null;
}

@Injectable()
export class BacklogSweepRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Waiting conversations across every account, oldest first.
   *
   * ⚠️ The order is the same `(backlog_at ASC, id ASC)` the per-account read uses, so a tick that can
   * only serve part of the queue serves the oldest part of it — across accounts as within one.
   */
  async waitingAcrossAccounts(limit: number): Promise<WaitingConversation[]> {
    return (await this.prisma.conversation.findMany({
      where: { backlog_at: { not: null }, assignee_operator_id: null },
      orderBy: [{ backlog_at: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        account_id: true,
        id: true,
        channel: true,
        brand_id: true,
        routed_group_id: true,
        backlog_at: true,
        unroutable_since: true,
      },
    })) as WaitingConversation[];
  }
}
