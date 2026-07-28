import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ArtefactPurgeRepository,
  type PurgeOutcome,
} from '../uploads/artefact-purge.repository';

/** Counts only. No ids, no keys, no filenames leave this boundary (SEC-26). */
export interface PurgeCounts {
  purged: number;
  objectMissing: number;
  failed: number;
}

/** The server's own ceiling on a batch, whatever a caller asks for. */
export const MAX_PURGE_BATCH = 500;
const DEFAULT_PURGE_BATCH = 100;

/**
 * Artefact expiry, enforced as DELETION (feature 017, US3 — FR-013/FR-014, research R7/R8).
 *
 * This service is the scheduling-facing half of the purge; the storage half is
 * {@link ArtefactPurgeRepository}, which lives beside the credentials it needs. The split is
 * deliberate: the thing that decides *how many and how often* has no business holding a bucket client,
 * and the thing that holds the bucket client has no business owning a policy.
 *
 * ── Why `users` and not the worker ───────────────────────────────────────────────────────────────
 * Only `users` holds object-store credentials (feature 016 / SEC-1), so only `users` can delete. The
 * worker's role is a tick — the same division of labour feature 014 established for the SLA sweep,
 * where the worker fires and `chats` decides.
 *
 * ── Why the two expiries do not coordinate ───────────────────────────────────────────────────────
 * `chats` flips its export record to `expired`; this deletes the bytes. Neither waits on the other and
 * neither reads the other's database (Principle VIII). Both predicates derive from ONE catalogue
 * constant and both are idempotent, so a downed peer delays nothing and loses nothing — whereas a
 * two-phase handshake between two services would create a state that is wrong whenever one of them is
 * restarting.
 *
 * A consequence worth stating plainly: for a short interval an export row may say `ready` while its
 * bytes are already gone. That is not a defect — the DOWNLOAD refuses on `expires_at` directly, not on
 * the swept status (see `ResolveExportArtefact`), so the answer never depends on how recently a tick ran.
 */
@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger(MaintenanceService.name);

  constructor(
    @Inject(ArtefactPurgeRepository) private readonly repo: ArtefactPurgeRepository,
  ) {}

  /**
   * Purge one batch of expired ephemeral artefacts.
   *
   * One artefact's failure never stops the pass: they are independent, and a row left behind is found
   * again on the next tick. That is the whole of FR-014's idempotence — there is no retry counter, no
   * dead-letter and no "purge attempted" column, because a row that still exists IS the retry.
   */
  async purgeExpiredArtefacts(limit: number, now: Date): Promise<PurgeCounts> {
    const batch = clampBatch(limit);
    const due = await this.repo.findExpired(batch, now);

    const counts: PurgeCounts = { purged: 0, objectMissing: 0, failed: 0 };
    for (const artefact of due) {
      let outcome: PurgeOutcome;
      try {
        outcome = await this.repo.purge(artefact);
      } catch {
        // A row-delete failure (the store already succeeded) — the artefact is bytes-free but still
        // listed, so the next tick will find it and report `object_missing`. Counted as failed here
        // because this pass did not finish the job.
        outcome = 'failed';
      }
      if (outcome === 'purged') counts.purged += 1;
      else if (outcome === 'object_missing') counts.objectMissing += 1;
      else counts.failed += 1;
    }

    if (counts.purged || counts.failed) {
      // Counts only. An expired artefact's key names its account and purpose, and this line is written
      // on every tick — the one place where routine logging would accumulate tenant activity over time.
      this.logger.log(
        `artefacts purged=${counts.purged} objectMissing=${counts.objectMissing} failed=${counts.failed}`,
      );
    }
    return counts;
  }
}

function clampBatch(limit: number): number {
  const n = Math.trunc(Number(limit ?? 0));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PURGE_BATCH;
  return Math.min(MAX_PURGE_BATCH, n);
}
