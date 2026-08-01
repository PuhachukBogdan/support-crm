import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PresenceState } from '@crm/common';
import { PresenceRepository } from './presence.repository';
import { PresenceService } from './presence.service';

/** Counts only. No ids and no account names leave this boundary (SEC-26). */
export interface SweepCounts {
  toAway: number;
  toOffline: number;
  failed: number;
}

/** The server's own ceiling on a batch, whatever a caller asks for. */
export const MAX_SWEEP_BATCH = 500;
const DEFAULT_SWEEP_BATCH = 200;

/** The job names itself in every transition it writes — `buildTransitionRow` refuses one that does not. */
export const PRESENCE_SWEEP_ACTOR = 'presence-sweep';

/**
 * Auto-away (feature 025, roadmap 5.9 — US2 / FR-014).
 *
 * ── ⚠️ Why this is a SWEEP and not computed at read time ────────────────────────────────────────
 * Computing "are they idle?" when somebody happens to look writes no transition until somebody looks.
 * The recorded timeline would then depend on who queried and when, and *"exactly one record per
 * change"* would silently become zero for anyone nobody happened to view. It also cannot be
 * verified live: there would be nothing to observe happening on its own.
 *
 * ── ⚠️ TWO thresholds, both measured from LAST ACTIVITY ─────────────────────────────────────────
 * Not from entering the previous state. With one threshold, `offline` would mean only *"never signed
 * in"* and somebody who went home would sit in `away` for ever. Measuring both from the same instant
 * means a long outage moves a person straight to `offline` in ONE step, writing one transition for
 * the state actually entered rather than a chain of them for states they passed through on paper.
 *
 * ── The invariant this cannot break ─────────────────────────────────────────────────────────────
 * The sweep only ever LOWERS availability (FR-016). It is enforced in `PresenceService.lowerFromSweep`
 * rather than here, so a future caller computing a different target cannot bypass it.
 *
 * ── ⚠️ It must actually FIRE ────────────────────────────────────────────────────────────────────
 * Feature 017's `ExpireDueExports` was written, hosted, unit-tested and **called by nothing**. Track A
 * structurally cannot see a missing tick, because a unit test does not know whether a scheduler
 * exists. `tests/worker/maintenance-ticks.spec.ts` guards the registration; the firing is Track B.
 */
@Injectable()
export class PresenceSweepService {
  private readonly logger = new Logger(PresenceSweepService.name);

  constructor(
    @Inject(PresenceRepository) private readonly repo: PresenceRepository,
    @Inject(PresenceService) private readonly presence: PresenceService,
  ) {}

  async sweepIdle(
    limit: number,
    now: Date,
    thresholds: { awayAfterSeconds: number; offlineAfterSeconds: number },
  ): Promise<SweepCounts> {
    const batch = clampBatch(limit);
    const awayCutoff = new Date(now.getTime() - thresholds.awayAfterSeconds * 1000);
    const offlineCutoff = new Date(now.getTime() - thresholds.offlineAfterSeconds * 1000);

    // The wider cutoff, so one query covers both transitions. The per-row decision below picks which.
    const candidates = await this.repo.idleSince(awayCutoff, batch);

    const counts: SweepCounts = { toAway: 0, toOffline: 0, failed: 0 };
    for (const row of candidates) {
      const seen = row.last_seen_at;
      if (!seen) continue; // never active — already `offline` by default, nothing to lower

      const target: PresenceState = seen < offlineCutoff ? 'offline' : 'away';
      try {
        const outcome = await this.presence.lowerFromSweep(
          row.account_id,
          row.auth_user_id,
          target,
          PRESENCE_SWEEP_ACTOR,
        );
        // `unchanged` is the normal answer on a second tick with no activity in between — the row is
        // already at or below the target, so there is nothing to write. It is not a failure and is
        // deliberately not counted as one.
        if (outcome.status === 'ok') {
          if (target === 'offline') counts.toOffline += 1;
          else counts.toAway += 1;
        }
      } catch {
        // One person's failure never stops the pass: they are independent, and a row left behind is
        // found again on the next tick. A row that still matches the predicate IS the retry — the
        // same idempotence the artefact purge relies on, with no retry counter to maintain.
        counts.failed += 1;
      }
    }

    if (counts.toAway || counts.toOffline || counts.failed) {
      // Counts only. This line is written on every tick, so it is the one place where routine logging
      // would otherwise accumulate a record of who works when — which is the surveillance question
      // this feature refuses (FR-037).
      this.logger.log(
        `presence swept away=${counts.toAway} offline=${counts.toOffline} failed=${counts.failed}`,
      );
    }
    return counts;
  }
}

function clampBatch(limit: number): number {
  const n = Math.trunc(Number(limit ?? 0));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SWEEP_BATCH;
  return Math.min(MAX_SWEEP_BATCH, n);
}
