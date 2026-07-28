import { Inject, Injectable } from '@nestjs/common';
import { EPHEMERAL_PURPOSE_NAMES, logInfo } from '@crm/common';
import { PrismaService } from '../prisma.service';
import { OBJECT_STORE, type ObjectStore } from './object-store';

/**
 * The ONE path in this product that removes stored bytes (feature 017, US3 — FR-013/FR-014, R8).
 *
 * ── Why this file exists, and why it is here ─────────────────────────────────────────────────────
 * Feature 016 said "nothing in v1 removes bytes", and that was the right rule for ingested content. An
 * artefact whose defining property is that it EXPIRES cannot honour it: a status flag saying `expired`
 * while the bytes sit in a bucket is SEC-27 rather than a fix for it. So the rule is NARROWED, not
 * weakened, and the narrowing is structural on four axes at once:
 *
 *   1. **Only `ephemeral` purposes are selectable** — and that set is DERIVED from the catalogue
 *      (`EPHEMERAL_PURPOSE_NAMES`), so an avatar or an attachment is unreachable from here by
 *      construction rather than by an exclusion list somebody has to keep correct.
 *   2. **Only a system actor can reach it** — through `UsersMaintenanceService`, which the gateway
 *      exposes no route to.
 *   3. **There is still no user-facing delete** — no `DeleteUpload`, no `UpdateUpload`, no presign;
 *      `tests/uploads/single-ingest-path.spec.ts` still asserts their absence.
 *   4. **It lives in `services/users/src/uploads/`**, the one folder allowed to reach the object store.
 *      Deletion is a storage operation, so it belongs beside the credentials rather than in a
 *      maintenance folder that would then need them.
 *
 * ── Object BEFORE row, and why that is the opposite of the create path ──────────────────────────
 * `UploadsRepository.create` puts the object first and writes the row second, because its worst
 * residue is an object with no row. Here the worst residue is the REVERSE: a row deleted while its
 * bytes survive leaves data nobody knows exists and no future pass can find — the bytes become
 * permanently unreclaimable, which is precisely the leak FR-013 is about. So the object goes first, and
 * a storage failure leaves the row exactly where the next tick will find it again.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

/** One expired artefact, as selected for purging. Keys and ids only — never a display name. */
export interface ExpiredArtefact {
  id: string;
  storage_key: string;
  derivative_key: string | null;
}

/** What happened to one artefact. `object_missing` is a NORMAL outcome, not an error. */
export type PurgeOutcome = 'purged' | 'object_missing' | 'failed';

@Injectable()
export class ArtefactPurgeRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  /**
   * Expired ephemeral artefacts, oldest first.
   *
   * Uses the BASE client rather than `forAccount`, for the same reason feature 014's SLA sweep and this
   * feature's export sweep do: the question is "what has expired anywhere", and a system actor has no
   * tenant context to scope to. The fencing that replaces it: the predicate is `purpose ∈ ephemeral`
   * plus a past `expires_at`, the projection is keys and ids only, the result is batch-capped, and the
   * only caller is a system-actor RPC with no route.
   *
   * `expires_at: { not: null }` is redundant next to `lt: now` and is written anyway — it states the
   * property the index is for, and it makes the predicate readable as "rows that HAVE an expiry, which
   * has passed" rather than as an accident of null-handling.
   */
  async findExpired(limit: number, now: Date): Promise<ExpiredArtefact[]> {
    return (await this.prisma.upload.findMany({
      where: {
        purpose: { in: [...EPHEMERAL_PURPOSE_NAMES] },
        expires_at: { not: null, lt: now },
      },
      orderBy: { expires_at: 'asc' },
      take: limit,
      select: { id: true, storage_key: true, derivative_key: true },
    })) as ExpiredArtefact[];
  }

  /**
   * Destroy one artefact: bytes, then the row.
   *
   * Idempotent by construction rather than by bookkeeping — a purged row is GONE, so it leaves the
   * predicate and a re-run finds nothing to do. There is no "purged" flag to reconcile and no window in
   * which a row is marked done but its bytes are not.
   */
  async purge(artefact: ExpiredArtefact): Promise<PurgeOutcome> {
    const keys = artefact.derivative_key
      ? [artefact.storage_key, artefact.derivative_key]
      : [artefact.storage_key];

    let anyPresent = false;
    try {
      for (const key of keys) {
        // Asked before deleting so "already absent" stays distinguishable from "we deleted it" — the
        // count an operator reads to know whether the sweep is doing work or catching up on rows whose
        // bytes something else removed.
        if (await this.store.exists(key)) {
          anyPresent = true;
          await this.store.delete(key);
        }
      }
    } catch {
      // The row STAYS. Deleting it now would orphan bytes that no later pass can find, which is worse
      // than retrying in five minutes. No cause is logged with the key — see below.
      logInfo('users', 'artefact.purge_storage_failed', { storageKey: artefact.storage_key });
      return 'failed';
    }

    // Unscoped by necessity (a system actor has no account) and safe because the id came from the
    // predicate above: `delete` by primary key cannot widen, and the row's bytes are already gone.
    await this.prisma.upload.delete({ where: { id: artefact.id } });

    return anyPresent ? 'purged' : 'object_missing';
  }
}
