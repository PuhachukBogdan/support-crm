import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { Cursor } from '../shared/cursor';
import type { MessageRow, Projection } from '../shared/wire';

const MESSAGE_SELECT = {
  id: true,
  conversation_id: true,
  author_type: true,
  author_id: true,
  body: true,
  private: true,
  mentions: true,
  created_at: true,
} as const;

export interface PostInput {
  conversationId: string;
  authorType: 'operator' | 'player' | 'system';
  authorId: string | null;
  body: string;
  isPrivate: boolean;
  mentions: string[];
}

/**
 * Message read/write path (feature 012, US2). Account-scoped via `forAccount` (Principle I). The
 * CUSTOMER thread projection excludes private-note rows AT THE QUERY (`private:false` + non-system),
 * so a private note is never loaded or serialised for a customer view — the SEC-13 guarantee is
 * structural, not a post-filter (research R4 / SC-002). Threads read chronologically (ASC keyset).
 *
 * Explicit @Inject: the runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class MessageRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** The conversation's brand (for the brand resource-check) — null when absent in this account. */
  async conversationBrand(accountId: string, conversationId: string): Promise<string | null> {
    const c = (await this.prisma.forAccount(accountId).conversation.findFirst({
      where: { id: conversationId },
      select: { brand_id: true },
    })) as { brand_id: string } | null;
    return c?.brand_id ?? null;
  }

  async thread(
    accountId: string,
    conversationId: string,
    projection: Projection,
    limit: number,
    cursor: Cursor | null,
  ): Promise<{ rows: MessageRow[]; nextCursor: Cursor | null }> {
    const where: Record<string, unknown> = { conversation_id: conversationId };
    if (projection === 'customer') {
      // SEC-13: private notes are NEVER loaded for a customer view; system entries excluded too.
      where.private = false;
      where.author_type = { not: 'system' };
    }
    if (cursor) {
      const at = new Date(cursor.createdAt);
      where.AND = [
        {
          OR: [
            { created_at: { gt: at } },
            { AND: [{ created_at: at }, { id: { gt: cursor.id } }] },
          ],
        },
      ];
    }

    const rows = (await this.prisma.forAccount(accountId).message.findMany({
      where,
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      select: MESSAGE_SELECT,
    })) as MessageRow[];

    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept[kept.length - 1];
    const nextCursor =
      hasMore && last ? { createdAt: last.created_at.toISOString(), id: last.id } : null;
    return { rows: kept, nextCursor };
  }

  async post(accountId: string, input: PostInput): Promise<MessageRow> {
    return (await this.prisma.forAccount(accountId).message.create({
      data: {
        account_id: accountId, // also injected by the scoped client; set explicitly for the type
        conversation_id: input.conversationId,
        author_type: input.authorType,
        author_id: input.authorId,
        body: input.body,
        private: input.isPrivate,
        // mentions are meaningful only on a private note (R6); empty otherwise.
        mentions: input.isPrivate ? input.mentions : [],
      },
      select: MESSAGE_SELECT,
    })) as MessageRow;
  }
}
