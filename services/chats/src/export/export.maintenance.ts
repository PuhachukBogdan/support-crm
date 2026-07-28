import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorLabel } from './error-label';
import { ExportRepository } from './export.repository';
import { ExportService } from './export.service';

/**
 * The export maintenance passes (feature 017, US1/US3 — research R3/R7).
 *
 * Both are called by the worker's repeatable ticks and both inherit every property feature 014
 * established for the SLA sweep: **system actor only, no gateway route, batch-capped, counts-only
 * responses**, and idempotent BY PREDICATE rather than by bookkeeping.
 *
 * ── Why the tick IS the queue ────────────────────────────────────────────────────────────────────
 * `chats` has no Redis configuration at all, so it cannot enqueue. Rather than give it a queue client,
 * new config keys and a compose edit for a latency improvement measured in seconds, the request writes a
 * `queued` row and the tick claims it. Postgres stays the source of truth, so a Redis flush costs one
 * tick of latency instead of losing work — the same reasoning 014 recorded for choosing a repeatable
 * sweep over a delayed job per clock.
 */
@Injectable()
export class ExportMaintenance {
  private readonly logger = new Logger(ExportMaintenance.name);

  constructor(
    @Inject(ExportRepository) private readonly repo: ExportRepository,
    @Inject(ExportService) private readonly service: ExportService,
  ) {}

  /**
   * Claim and run due exports; recover stale claims.
   *
   * A `running` row whose claim is older than `staleAfterMs` is a producer that died — a deploy, an OOM,
   * a container restart. It is failed with `interrupted` rather than retried, because the requester is
   * waiting on a terminal answer and a silently re-run export could double-charge the quota. That is
   * what makes SC-010 ("an interrupted producer leaves no downloadable partial artefact") provable
   * rather than hoped for.
   */
  async runDueExports(
    limit: number,
    now: Date,
    staleAfterMs: number,
  ): Promise<{ claimed: number; completed: number; failed: number; recoveredStale: number }> {
    const due = await this.repo.findDue(limit, new Date(now.getTime() - staleAfterMs));

    let claimed = 0;
    let completed = 0;
    let failed = 0;
    let recoveredStale = 0;

    for (const row of due) {
      if (row.status === 'running') {
        // Stale claim. `recoverStale` is conditional on `running`, so a concurrent tick that already
        // recovered it simply gets `false`.
        if (await this.repo.recoverStale(row.account_id, row.id, now)) recoveredStale += 1;
        continue;
      }

      // The conditional claim is the whole concurrency story: two overlapping ticks both try, exactly
      // one wins, the loser moves on with no bookkeeping to reconcile.
      if (!(await this.repo.claim(row.account_id, row.id, now))) continue;
      claimed += 1;

      const full = await this.repo.getOwnedForRun(row.account_id, row.id);
      if (!full) {
        // Claimed but unreadable — treat as a failure rather than leaving it `running` forever.
        failed += 1;
        continue;
      }

      try {
        const outcome = await this.service.run(full, now);
        if (outcome === 'completed') completed += 1;
        else failed += 1;
      } catch (err) {
        // One export blowing up must not stop the pass: the rest are independent, and this one is
        // already terminal or will be recovered as stale on a later tick.
        failed += 1;
        this.logger.warn(`export run threw for ${row.id}: ${errorLabel(err)}`);
      }
    }

    // COUNTS ONLY — no export ids, no scopes, no filter values cross this boundary.
    return { claimed, completed, failed, recoveredStale };
  }

  /**
   * Flip `ready` rows past their expiry to `expired`.
   *
   * The BYTES are removed independently, by `users`, on its own `expires_at` predicate (research R7).
   * Neither service waits on the other: a downed peer delays nothing and loses nothing, because both
   * predicates are derived from the same TTL and both are idempotent. This pass clears `upload_id` so
   * the row stops pointing at bytes that no longer exist.
   */
  async expireDueExports(limit: number, now: Date): Promise<{ expired: number }> {
    const rows = await this.repo.findExpired(limit, now);
    let expired = 0;
    for (const row of rows) {
      if (await this.repo.markExpired(row.account_id, row.id)) expired += 1;
    }
    return { expired };
  }
}
