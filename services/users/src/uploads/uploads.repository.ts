import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { logInfo } from '@crm/common';
import { PrismaService } from '../prisma.service';
import { OBJECT_STORE, type ObjectStore } from './object-store';
import type { ValidatedUpload } from './validate';

/**
 * Upload persistence (feature 016, US1 — FR-009/FR-015/FR-016/FR-018).
 *
 * `forAccount` throughout, without exception. That is what makes "not yours" and "does not exist"
 * the SAME query result rather than two branches a future edit could separate (FR-011): there is no
 * `if (row.account_id !== caller)` anywhere here to get wrong, because a row from another account
 * never comes back in the first place.
 *
 * ── The storage key is not a security boundary ───────────────────────────────────────────────────
 * `{account_id}/{purpose}/{uuid}` reads well in a bucket listing and that is ALL it is for.
 * Authorization is the `account_id` column plus the scoped client. Treating a path prefix as a
 * boundary is how bucket-privacy bugs happen, so it is written down here rather than assumed.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

export interface UploadRow {
  id: string;
  account_id: string;
  purpose: string;
  uploader_user_id: string;
  content_type: string;
  byte_size: number;
  checksum_sha256: string;
  storage_key: string;
  display_name: string | null;
  derivative_key: string | null;
  derivative_byte_size: number | null;
  state: string;
  claimed_at: Date | null;
  created_at: Date;
}

const ROW_SELECT = {
  id: true,
  account_id: true,
  purpose: true,
  uploader_user_id: true,
  content_type: true,
  byte_size: true,
  checksum_sha256: true,
  storage_key: true,
  display_name: true,
  derivative_key: true,
  derivative_byte_size: true,
  state: true,
  claimed_at: true,
  created_at: true,
} as const;

/** A claim could not be honoured in full. Carries no ids — the caller knows what it asked for. */
export class ClaimRefused extends Error {
  constructor() {
    super('claim refused');
    this.name = 'ClaimRefused';
  }
}

@Injectable()
export class UploadsRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  /**
   * Store the accepted bytes and record them.
   *
   * ── The ordering IS the guarantee (FR-009 / SC-011) ────────────────────────────────────────────
   * Validation and derivative production have already succeeded when this is called, so the only
   * reachable failure residue is an ORPHANED OBJECT WITH NO ROW — invisible to the product and
   * unreclaimable, because nothing knows it exists. The put is therefore the last thing before the
   * row, and a failed row write triggers a best-effort delete plus a logged discrepancy.
   *
   * The reverse order (row first, then put) fails toward a RECORDED upload whose bytes are not
   * there, which is worse: a consumer will reference it and every read will fail forever.
   *
   * The checksum is computed here because the bytes are already in memory — it costs nothing and it
   * is the only corruption signal this feature has. It is NOT an integrity chain against someone
   * holding storage credentials (spec Assumptions), exactly as feature 015 said of the audit log.
   */
  async create(
    accountId: string,
    uploaderUserId: string,
    validated: ValidatedUpload,
  ): Promise<UploadRow> {
    const base = `${accountId}/${validated.purposeName}/${randomUUID()}`;
    const derivativeKey = validated.derivative ? `${base}.thumb.webp` : null;

    await this.store.put(base, validated.bytes, validated.contentType);
    if (validated.derivative && derivativeKey) {
      await this.store.put(
        derivativeKey,
        validated.derivative.body,
        validated.derivative.contentType,
      );
    }

    try {
      return (await this.prisma.forAccount(accountId).upload.create({
        data: {
          account_id: accountId, // also injected by the scoped client; explicit for the type
          purpose: validated.purposeName,
          uploader_user_id: uploaderUserId,
          content_type: validated.contentType,
          byte_size: validated.bytes.byteLength,
          checksum_sha256: sha256(validated.bytes),
          storage_key: base,
          display_name: validated.displayName,
          derivative_key: derivativeKey,
          derivative_byte_size: validated.derivative?.byteSize ?? null,
          // Feature 017 (research R7/R8): an EPHEMERAL purpose's bytes carry the moment they stop being
          // allowed to exist. Null for every other purpose — an avatar or an attachment must never
          // acquire an expiry, because the purge keys on exactly this column.
          expires_at: validated.purpose.ephemeral
            ? new Date(Date.now() + validated.purpose.ttlSeconds * 1000)
            : null,
        },
        select: ROW_SELECT,
      })) as UploadRow;
    } catch (err) {
      await this.discardOrphans(base, derivativeKey);
      throw err;
    }
  }

  /**
   * Best-effort cleanup after a failed row write.
   *
   * The log line names the STORAGE KEYS — system-generated identifiers, never a filename and never
   * a byte of content (FR-020 / SEC-26). Without them an operator has no way to find what to remove;
   * with a filename it would be a PII leak in the one place PII is hardest to redact later.
   *
   * A failure to delete is swallowed on purpose: the row write already failed and is being
   * rethrown, and masking that with a cleanup error would report the wrong problem.
   */
  private async discardOrphans(key: string, derivativeKey: string | null): Promise<void> {
    const orphans = derivativeKey ? [key, derivativeKey] : [key];
    for (const k of orphans) {
      try {
        await this.store.delete(k);
      } catch {
        logInfo('users', 'upload.orphan_object_not_removed', { storageKey: k });
      }
    }
    logInfo('users', 'upload.record_write_failed', { storageKeys: orphans });
  }

  /**
   * Claim uploads for a consumer that is about to reference them (research R8). ALL-OR-NOTHING.
   *
   * ── Why an INTERACTIVE transaction here, when everything else uses the batch form ──────────────
   * The decision depends on a result the database produces: `updateMany` reports how many rows it
   * actually moved, and anything short of the full set must undo the ones that did. Throwing inside
   * the callback is what rolls them back; a compensating update afterwards would be a second race.
   * The batch form cannot express read-then-decide, which is why 013/014/015 could use it and this
   * cannot. `db.$transaction(...)` is still called as a METHOD — feature 013's live-only defect was
   * pulling `$transaction` into a variable, losing its `this`, and dying on `_engineConfig`.
   *
   * ── Why `account_id` is written out in the predicate ────────────────────────────────────────────
   * `db` IS the feature-007 scoped client and its extension would add exactly this clause. It is
   * repeated here on purpose: this is the one place in the product where a query runs through a
   * transaction handle rather than the client directly, and the isolation invariant is
   * NON-NEGOTIABLE (Principle I). Making the predicate explicit means correctness does not depend on
   * how a Prisma version propagates query extensions into an interactive transaction. Belt and
   * braces — not a replacement for the extension, and not a licence to omit it elsewhere.
   *
   * `state: 'pending'` then does three jobs at once: an unknown id does not match, an id from
   * another account does not match, and an already claimed id does not match. All three are the SAME
   * refusal, which is exactly right — none may be distinguishable to a caller probing for what
   * exists (FR-011).
   */
  async claim(accountId: string, uploadIds: string[], claimedBy: string): Promise<string[]> {
    const ids = [...new Set(uploadIds)];
    if (ids.length === 0) return [];

    const db = this.prisma.forAccount(accountId);
    await db.$transaction(async (tx) => {
      const res = await tx.upload.updateMany({
        where: { account_id: accountId, id: { in: ids }, state: 'pending' },
        data: { state: 'claimed', claimed_at: new Date() },
      });
      if (res.count !== ids.length) throw new ClaimRefused();
    });

    // `claimedBy` is opaque provenance for diagnostics — deliberately not persisted as a joinable
    // key. The consumer's own table holds the real reference; a second, weaker copy of it here
    // would be a reference that can silently disagree with the first.
    logInfo('users', 'upload.claimed', { count: ids.length, claimedBy });
    return ids;
  }

  /**
   * One upload, for a read (feature 016, US2 / T046).
   *
   * `forAccount` + `findFirst` is deliberate: "not yours" and "does not exist" are the SAME query
   * result here, not two branches a future edit could separate into two different answers. There is
   * no `row.account_id !== caller` comparison anywhere in this file to get wrong, and no code path
   * where a cross-account row is in hand and merely not returned (FR-011).
   */
  async resolveForRead(accountId: string, uploadId: string): Promise<UploadRow | null> {
    if (!uploadId) return null;
    return (await this.prisma.forAccount(accountId).upload.findFirst({
      where: { id: uploadId },
      select: ROW_SELECT,
    })) as UploadRow | null;
  }

  /** Fetch stored bytes by key. Null when the object is gone (a row without its object). */
  async fetchObject(key: string): Promise<Uint8Array | null> {
    return this.store.get(key);
  }

  /**
   * Metadata for an explicit, already length-capped set of ids (FR-023 — never "all uploads
   * matching X"). An id from another account is simply ABSENT from the result; the response never
   * distinguishes "not yours" from "does not exist".
   */
  async describe(accountId: string, uploadIds: string[]): Promise<UploadRow[]> {
    const ids = [...new Set(uploadIds)];
    if (ids.length === 0) return [];
    return (await this.prisma.forAccount(accountId).upload.findMany({
      where: { id: { in: ids } },
      select: ROW_SELECT,
    })) as UploadRow[];
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

