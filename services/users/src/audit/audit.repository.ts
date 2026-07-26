import { Inject, Injectable } from '@nestjs/common';
import {
  buildEntry,
  decodeEntryCursor,
  encodeEntryCursor,
  isAuditAction,
  isAuditClass,
  actionsOfClass,
  type AuditEntryInput,
  type AuditEntryRow,
} from '@crm/common';
import { PrismaService } from '../prisma.service';

/**
 * Audit-trail persistence (feature 015, roadmap 4.8). **This file is intentionally identical in auth, users
 * and chats** — the table cannot be shared (one database per service, Principle VIII) and the entry must be
 * written inside the transaction of the action it describes (spec Q3), so the trail lives beside its
 * actions and only the code is shared.
 *
 * ── Append-only, structurally ──────────────────────────────────────────────────────────────────────
 * There is no `update` and no `delete` method here, and there never should be. Audit integrity is not a
 * permission anyone can hold — including the owner — so the guarantee is the ABSENCE of the path, not a
 * check on it. `tests/audit/append-only.spec.ts` asserts that absence across every service and the gateway.
 *
 * ── Two ways to write, and why ─────────────────────────────────────────────────────────────────────
 * `statement()` returns an unexecuted Prisma create for a caller to put **inside its own transaction** —
 * that is what makes "the action and its entry succeed together" true (FR-009). `append()` writes on its own
 * and exists only for acts that are not themselves mutations (reading the log).
 *
 * The BATCH form of `$transaction` is what callers use with `statement()`. That is deliberate: feature 013's
 * live-only defect was pulling `$transaction` into a variable and losing its `this`, after which Prisma died
 * on `_engineConfig`. Nothing here needs a read inside the transaction, so the form that cannot have that
 * bug is the one used.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */

export const AUDIT_SOURCE = 'users';

export interface AuditFilters {
  actorUserId?: string;
  /** An exact action, or a whole class — not both. */
  action?: string;
  actionClass?: string;
  targetRef?: string;
  from?: string;
  to?: string;
}

export class AuditFilterError extends Error {}

const SELECT = {
  id: true,
  actor_user_id: true,
  actor_kind: true,
  actor_ref: true,
  under_preview: true,
  action: true,
  target_ref: true,
  detail_json: true,
  created_at: true,
} as const;

@Injectable()
export class AuditRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Build the unexecuted create for `entry`, to be placed inside the CALLER's transaction. Validation
   * (unknown action, missing actor, inexpressible detail) happens here and therefore **before** the
   * transaction opens — a refused entry means the action never starts, rather than being rolled back.
   */
  statement(accountId: string, input: AuditEntryInput): unknown {
    const data = buildEntry(input);
    return this.prisma.forAccount(accountId).auditEntry.create({
      data: { account_id: accountId, ...data, detail_json: data.detail_json ?? undefined },
    });
  }

  /**
   * Write an entry on its own. Only for acts that are not mutations (reading the log) — a mutation must use
   * {@link statement} so that action and entry share one transaction.
   */
  async append(accountId: string, input: AuditEntryInput): Promise<void> {
    const data = buildEntry(input);
    await this.prisma.forAccount(accountId).auditEntry.create({
      data: { account_id: accountId, ...data, detail_json: data.detail_json ?? undefined },
    });
  }

  /**
   * One source's page of the trail, ordered `(created_at DESC, id DESC)` — the ordering the federated merge
   * depends on. Filters are pushed into the query so the merge never sees rows it would discard.
   */
  async list(
    accountId: string,
    filters: AuditFilters,
    limit: number,
    pageToken?: string,
  ): Promise<{ rows: AuditEntryRow[]; nextPageToken: string }> {
    const where: Record<string, unknown> = {};

    if (filters.actorUserId) where.actor_user_id = filters.actorUserId;
    if (filters.targetRef) where.target_ref = filters.targetRef;

    // An unrecognised filter is REFUSED, never dropped: silently ignoring it would widen the result to
    // everything, which looks like a successful query and is the opposite of what the caller asked for.
    if (filters.action && filters.actionClass) {
      throw new AuditFilterError('specify either action or action_class, not both');
    }
    if (filters.action) {
      if (!isAuditAction(filters.action)) throw new AuditFilterError('unknown action');
      where.action = filters.action;
    }
    if (filters.actionClass) {
      if (!isAuditClass(filters.actionClass)) throw new AuditFilterError('unknown action class');
      where.action = { in: actionsOfClass(filters.actionClass) };
    }

    const createdAt: Record<string, Date> = {};
    if (filters.from) createdAt.gte = parseInstant(filters.from, 'from');
    if (filters.to) createdAt.lt = parseInstant(filters.to, 'to');
    if (Object.keys(createdAt).length > 0) where.created_at = createdAt;

    const cursor = decodeEntryCursor(pageToken);
    if (cursor) {
      const at = new Date(cursor.createdAt);
      where.OR = [{ created_at: { lt: at } }, { AND: [{ created_at: at }, { id: { lt: cursor.id } }] }];
    }

    const rows = (await this.prisma.forAccount(accountId).auditEntry.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: SELECT,
    })) as AuditEntryRow[];

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept[kept.length - 1];
    return {
      rows: kept,
      // A real keyset cursor for "more from here", so a single-source caller can page normally. The
      // federated reader does NOT resume from it: it recomputes each source's position from the rows it
      // actually consumed (libs/common/audit/merge.ts), because a source can hand over more rows than fit
      // in the merged page. Here the token's other job is simply to say "this source is not exhausted".
      nextPageToken:
        hasMore && last
          ? encodeEntryCursor({ createdAt: last.created_at.toISOString(), id: last.id })
          : '',
    };
  }
}

function parseInstant(value: string, field: string): Date {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new AuditFilterError(`invalid ${field} timestamp`);
  return at;
}
