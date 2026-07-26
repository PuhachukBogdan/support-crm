import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE ONE UNSCOPED TENANT READ IN THIS SERVICE. Read this before changing anything here.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Feature 014, research **R3** — logged in the plan's Complexity Tracking so it is reviewed rather
 * than discovered.
 *
 * **Why it has to exist.** A timer has no caller, therefore no account context, and
 * `PrismaService.forAccount()` throws without one — by design, fail-closed. But a first-reply breach
 * is precisely the event nobody is waiting for (FR-014/SC-006): no request is open, no operator is
 * looking. Detecting it requires one tenant-agnostic step to answer "which accounts have overdue
 * clocks", and there is no way to ask that question through a per-account client.
 *
 * **Why it is judged compliant with Principle I rather than a violation.** Principle I's property is
 * that *a caller cannot reach another account's data*. That still holds, five ways over:
 *
 *   1. **Ids only.** The `select` is `{ account_id, conversation_id }`. No body, no player_id, no
 *      status, no assignee — nothing that is or approximates PII (Principle IV).
 *   2. **Nothing leaves the service.** The sweep RPC answers with COUNTS. These ids are never
 *      serialised into a response, not even for a system caller.
 *   3. **No caller can reach it.** It is invoked only from `ChatsMaintenanceService`, which requires
 *      `x-actor-kind: system` metadata and has NO gateway route (asserted by a gateway spec).
 *   4. **Every write stays scoped.** This step selects *which* accounts have work; all reads and
 *      writes that follow go through `forAccount(accountId)` exactly like every other path.
 *   5. **Bounded.** `limit` is server-capped, so one tick cannot scan the world.
 *
 * **Alternatives that were rejected** (research R3): iterating accounts needs a list of all accounts,
 * which auth does not expose — adding `ListAccounts` would move this identical read into auth *and*
 * give it a caller-facing surface (strictly worse). A tenant list in the worker's env hardcodes ids in
 * infrastructure and silently stops sweeping any account added later.
 *
 * **Do not add anything else to this file.** Its value is that it is exactly one method, easy to audit
 * in full. A second unscoped query belongs in a design discussion, not here.
 */

/** An overdue clock, identified only enough to act on it under its own account scope. */
export interface DueConversation {
  account_id: string;
  conversation_id: string;
}

@Injectable()
export class SlaSweepRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Conversations across ALL accounts whose first-reply clock is still running and whose deadline has
   * passed. Ordered by deadline so the oldest breach is handled first when the batch is capped.
   *
   * Uses the base client deliberately (see the file header). The predicate matches the
   * `(outcome, deadline_at)` index, which exists for exactly this query.
   */
  async findDueConversationIds(limit: number, now: Date): Promise<DueConversation[]> {
    return (await this.prisma.conversationSlaState.findMany({
      where: {
        outcome: 'running',
        breach_announced_at: null,
        deadline_at: { lte: now },
      },
      orderBy: [{ deadline_at: 'asc' }],
      take: Math.max(1, Math.min(5_000, Math.trunc(limit) || 1)),
      // IDS ONLY. Adding a field here is a Principle-I change, not a convenience.
      select: { account_id: true, conversation_id: true },
    })) as DueConversation[];
  }
}
