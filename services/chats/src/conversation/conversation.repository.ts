import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { Cursor } from '../shared/cursor';
import type {
  ConversationDetailRow,
  ConversationSummaryRow,
  DbStatus,
} from '../shared/wire';

const SUMMARY_SELECT = {
  id: true,
  brand_id: true,
  player_id: true,
  status: true,
  priority: true,
  assignee_operator_id: true,
  channel: true,
  created_at: true,
  updated_at: true,
} as const;

const DETAIL_SELECT = {
  ...SUMMARY_SELECT,
  reference: true,
  category: true,
  sub_category: true,
  classified_by: true,
} as const;

export interface ListFilters {
  status?: DbStatus;
  priority?: string;
  assigneeOperatorId?: string;
  playerId?: string;
  /** Brand restriction: undefined = none; [] = deliberately empty (permitted set excludes the ask). */
  brandIn?: string[];
  limit: number;
  cursor: Cursor | null;
}

export interface CreateInput {
  brandId: string;
  playerId?: string;
  priority?: string;
  channel?: string;
  assigneeOperatorId?: string;
}

/**
 * Conversation read/write path (feature 012, US1). Every operation runs under the account-scoped,
 * fail-closed client (`forAccount`, feature 007 / Principle I). Uses `findFirst`/`updateMany` (never
 * `findUnique`) so the injected `account_id` predicate composes cleanly. Cross-service ids
 * (brand/player/assignee) are soft refs — never joined (Principle VIII). Keyset paging only
 * (Principle VII): order `(created_at DESC, id DESC)`, `take: limit + 1` to compute the next cursor.
 *
 * Explicit @Inject: the runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class ConversationRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(
    accountId: string,
    f: ListFilters,
  ): Promise<{ rows: ConversationSummaryRow[]; nextCursor: Cursor | null }> {
    const where: Record<string, unknown> = {};
    if (f.status) where.status = f.status;
    if (f.priority) where.priority = f.priority;
    if (f.assigneeOperatorId) where.assignee_operator_id = f.assigneeOperatorId;
    if (f.playerId) where.player_id = f.playerId;
    if (f.brandIn) where.brand_id = { in: f.brandIn };

    if (f.cursor) {
      const at = new Date(f.cursor.createdAt);
      where.AND = [
        {
          OR: [
            { created_at: { lt: at } },
            { AND: [{ created_at: at }, { id: { lt: f.cursor.id } }] },
          ],
        },
      ];
    }

    const rows = (await this.prisma.forAccount(accountId).conversation.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: f.limit + 1,
      select: SUMMARY_SELECT,
    })) as ConversationSummaryRow[];

    const hasMore = rows.length > f.limit;
    const kept = hasMore ? rows.slice(0, f.limit) : rows;
    const last = kept[kept.length - 1];
    const nextCursor =
      hasMore && last ? { createdAt: last.created_at.toISOString(), id: last.id } : null;
    return { rows: kept, nextCursor };
  }

  async getById(accountId: string, id: string): Promise<ConversationDetailRow | null> {
    return (await this.prisma.forAccount(accountId).conversation.findFirst({
      where: { id },
      select: DETAIL_SELECT,
    })) as ConversationDetailRow | null;
  }

  async create(accountId: string, input: CreateInput): Promise<ConversationDetailRow> {
    return (await this.prisma.forAccount(accountId).conversation.create({
      data: {
        // account_id is also injected by the scoped client (feature 007); set explicitly to the
        // same value so the static create type is satisfied (the extension applies it last).
        account_id: accountId,
        brand_id: input.brandId,
        player_id: input.playerId ?? null,
        priority: input.priority ?? null,
        channel: input.channel ?? null,
        assignee_operator_id: input.assigneeOperatorId ?? null,
      },
      select: DETAIL_SELECT,
    })) as ConversationDetailRow;
  }

  /** Set status; returns the updated row, or null when the id is not in this account. */
  async setStatus(
    accountId: string,
    id: string,
    status: DbStatus,
  ): Promise<ConversationDetailRow | null> {
    const res = await this.prisma.forAccount(accountId).conversation.updateMany({
      where: { id },
      data: { status },
    });
    if (res.count === 0) return null;
    return this.getById(accountId, id);
  }
}
