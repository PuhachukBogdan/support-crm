import { Inject, Injectable } from '@nestjs/common';
import type { ExportFailureReason, ExportScopeName } from '@crm/common';
import { PrismaService } from '../prisma.service';
import type { Cursor } from '../shared/cursor';

/**
 * Export records (feature 017, US1 — roadmap 4.10).
 *
 * Every tenant-facing operation runs under the account-scoped, fail-closed client (`forAccount`,
 * feature 007 / Principle I). `findFirst`/`updateMany` rather than `findUnique`/`update`, so the
 * injected `account_id` predicate composes — the same rule the conversation repository follows.
 *
 * The two maintenance reads at the bottom are the deliberate exception: they select by STATUS across
 * accounts because the sweep has no caller and therefore no tenant context. They return ids and
 * account ids only, and every write that follows goes back through `forAccount` — the exact fencing
 * feature 014's SLA sweep established.
 *
 * Explicit @Inject: the runtime (tsx/esbuild) emits no decorator metadata.
 */
export interface ExportJobRow {
  id: string;
  account_id: string;
  scope: string;
  format: string;
  requested_by: string;
  status: string;
  row_count: number | null;
  byte_size: number | null;
  upload_id: string | null;
  failure_reason: string | null;
  expires_at: Date;
  created_at: Date;
  completed_at: Date | null;
}

const ROW_SELECT = {
  id: true,
  account_id: true,
  scope: true,
  format: true,
  requested_by: true,
  status: true,
  row_count: true,
  byte_size: true,
  upload_id: true,
  failure_reason: true,
  expires_at: true,
  created_at: true,
  completed_at: true,
} as const;

export interface CreateExportInput {
  scope: ExportScopeName;
  format: string;
  requestedBy: string;
  filters: Record<string, unknown>;
  expiresAt: Date;
}

/** What the completion transaction writes, alongside the audit entry (FR-018/FR-020). */
export interface CompleteExportInput {
  rowCount: number;
  byteSize: number;
  uploadId: string;
}

@Injectable()
export class ExportRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(accountId: string, input: CreateExportInput): Promise<ExportJobRow> {
    return (await this.prisma.forAccount(accountId).exportJob.create({
      data: {
        // Also injected by the scoped client (feature 007); set explicitly so the static create type
        // is satisfied — the extension applies it last.
        account_id: accountId,
        scope: input.scope,
        format: input.format,
        requested_by: input.requestedBy,
        // Prisma's Json input type does not accept a bare `Record<string, unknown>`; the cast is at the
        // boundary only, and the value is built from a validated filter set (never a raw request body).
        filters_json: input.filters as never,
        status: 'queued',
        expires_at: input.expiresAt,
      },
      select: ROW_SELECT,
    })) as ExportJobRow;
  }

  /**
   * One export, for its OWNER only.
   *
   * Owner-scoping lives here rather than in the caller, so there is no path that reads a row without
   * it. A same-account non-owner gets `null` — indistinguishable from an unknown id, which is what
   * FR-011 requires: four different situations, one answer, no existence oracle.
   */
  async getOwned(accountId: string, id: string, requestedBy: string): Promise<ExportJobRow | null> {
    return (await this.prisma.forAccount(accountId).exportJob.findFirst({
      where: { id, requested_by: requestedBy },
      select: ROW_SELECT,
    })) as ExportJobRow | null;
  }

  /**
   * One export by id for the RUNNER — no owner predicate, because the runner is not a user.
   *
   * Still account-scoped: `forAccount` is the only path to the row, and the account comes from the
   * id-only maintenance read that selected it. Separate from {@link getOwned} on purpose — a method that
   * skips the owner check must be impossible to reach from a request path by accident, and naming it for
   * the runner is what makes a reviewer notice if it ever appears in a controller.
   */
  async getOwnedForRun(accountId: string, id: string): Promise<ExportJobRow | null> {
    return (await this.prisma.forAccount(accountId).exportJob.findFirst({
      where: { id },
      select: { ...ROW_SELECT, filters_json: true },
    })) as ExportJobRow | null;
  }

  /** The caller's OWN exports, keyset-ordered `(created_at DESC, id DESC)`. */
  async listOwn(
    accountId: string,
    requestedBy: string,
    limit: number,
    cursor: Cursor | null,
  ): Promise<{ rows: ExportJobRow[]; nextCursor: Cursor | null }> {
    const where: Record<string, unknown> = { requested_by: requestedBy };
    if (cursor) {
      const at = new Date(cursor.createdAt);
      where.AND = [
        {
          OR: [
            { created_at: { lt: at } },
            { AND: [{ created_at: at }, { id: { lt: cursor.id } }] },
          ],
        },
      ];
    }

    const rows = (await this.prisma.forAccount(accountId).exportJob.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: ROW_SELECT,
    })) as ExportJobRow[];

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept[kept.length - 1];
    return {
      rows: kept,
      nextCursor:
        hasMore && last ? { createdAt: last.created_at.toISOString(), id: last.id } : null,
    };
  }

  /** How many exports this requester created inside the trailing window — the quota count (R11). */
  async countInWindow(accountId: string, requestedBy: string, since: Date): Promise<number> {
    return this.prisma.forAccount(accountId).exportJob.count({
      where: { requested_by: requestedBy, created_at: { gte: since } },
    });
  }

  /**
   * Claim a queued row: `queued → running`, CONDITIONALLY.
   *
   * The `status: 'queued'` predicate is the whole of the concurrency story. Two overlapping ticks both
   * issue this update; exactly one matches a row, and the other gets `count: 0` and moves on. There is
   * no "have I already claimed this?" read to race with, and no dedup bookkeeping to get wrong — the
   * same reasoning feature 014 used for announce-once, and feature 013 for at-most-once.
   */
  async claim(accountId: string, id: string, now: Date): Promise<boolean> {
    const res = await this.prisma.forAccount(accountId).exportJob.updateMany({
      where: { id, status: 'queued' },
      data: { status: 'running', claimed_at: now },
    });
    return res.count === 1;
  }

  /** Terminal failure. Stores no artefact reference — a partial artefact is never referenced (FR-015). */
  async fail(
    accountId: string,
    id: string,
    reason: ExportFailureReason,
    now: Date,
  ): Promise<boolean> {
    const res = await this.prisma.forAccount(accountId).exportJob.updateMany({
      where: { id, status: 'running' },
      data: { status: 'failed', failure_reason: reason, completed_at: now },
    });
    return res.count === 1;
  }

  /**
   * The completion statement — UNEXECUTED, to be placed inside the caller's transaction alongside the
   * audit entry (FR-018/FR-020).
   *
   * Returning a statement rather than performing the write is what lets `ExportService` put the row
   * transition and the `export.create` entry in ONE `$transaction`: if the entry cannot be written the
   * transaction rolls back, the export never becomes `ready`, and it is refused rather than completed
   * unaudited. The same shape `AuditRepository.statement()` uses, for the same reason.
   */
  completeStatement(accountId: string, id: string, input: CompleteExportInput, now: Date): unknown {
    return this.prisma.forAccount(accountId).exportJob.updateMany({
      where: { id, status: 'running' },
      data: {
        status: 'ready',
        row_count: input.rowCount,
        byte_size: input.byteSize,
        upload_id: input.uploadId,
        completed_at: now,
      },
    });
  }

  /** Run both statements in ONE transaction. Called as a METHOD — see the note below. */
  async runInTransaction(statements: unknown[]): Promise<void> {
    /**
     * `this.prisma.$transaction(...)` — NOT a destructured reference.
     *
     * Pulling `$transaction` into a variable loses its `this`, and Prisma then dies on
     * `this._engineConfig`. That is feature 013's live defect: every auto-assignment 500ed, and no unit
     * test caught it because a standalone test fake never needs `this`. The fake in this feature's spec
     * asserts its own binding for exactly that reason.
     */
    await this.prisma.$transaction(statements as never);
  }

  // ── Maintenance reads: unscoped by necessity, fenced by construction ──────────────────────────
  //
  // These use the BASE client (`this.prisma`, i.e. the PrismaClient this service extends) rather than
  // `forAccount`, deliberately and for the same reason feature 014's sweep does: the question is
  // "which accounts have work waiting", and there is no way to ask that through a per-account client.
  //
  // The sweep has no caller, so there is no account to scope to. Both reads select by STATUS, return
  // ids only, are batch-capped, and are reachable only from a system-actor RPC with no gateway route.
  // Every write that follows goes through `forAccount`.

  /** Queued rows waiting for a runner, plus `running` rows whose claim has gone stale. */
  async findDue(
    limit: number,
    staleBefore: Date,
  ): Promise<Array<{ id: string; account_id: string; status: string }>> {
    return (await this.prisma.exportJob.findMany({
      where: {
        OR: [{ status: 'queued' }, { status: 'running', claimed_at: { lt: staleBefore } }],
      },
      orderBy: { created_at: 'asc' },
      take: limit,
      select: { id: true, account_id: true, status: true },
    })) as Array<{ id: string; account_id: string; status: string }>;
  }

  /** `ready` rows past their expiry. The BYTES are purged independently by `users` (research R7). */
  async findExpired(
    limit: number,
    now: Date,
  ): Promise<Array<{ id: string; account_id: string }>> {
    return (await this.prisma.exportJob.findMany({
      where: { status: 'ready', expires_at: { lt: now } },
      orderBy: { expires_at: 'asc' },
      take: limit,
      select: { id: true, account_id: true },
    })) as Array<{ id: string; account_id: string }>;
  }

  /**
   * `ready → expired`, conditionally, and it also clears `upload_id`.
   *
   * Clearing the reference matters: the row survives as the record that this export happened (the audit
   * trail says who and what), but it must stop pointing at bytes that no longer exist. A stale
   * reference would make a 404 look like a bug instead of the designed end of an artefact's life.
   */
  async markExpired(accountId: string, id: string): Promise<boolean> {
    const res = await this.prisma.forAccount(accountId).exportJob.updateMany({
      where: { id, status: 'ready' },
      data: { status: 'expired', upload_id: null },
    });
    return res.count === 1;
  }

  /** Recover a stale claim: `running → failed/interrupted`, so no row is `running` forever (SC-010). */
  async recoverStale(accountId: string, id: string, now: Date): Promise<boolean> {
    return this.fail(accountId, id, 'interrupted', now);
  }
}
