import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { Cursor } from '../shared/cursor';
import type { MessageRow, Projection } from '../shared/wire';

/**
 * Feature 016: attachment links are selected THROUGH the message, as a nested select. That is the
 * whole of FR-013 for attachments — the customer projection excludes private-note ROWS at the query,
 * so their attachment rows are never loaded either. Nothing anywhere fetches attachments by a
 * separate query, and `private-note-attachments.spec.ts` asserts the outcome.
 */
const MESSAGE_SELECT = {
  id: true,
  conversation_id: true,
  author_type: true,
  author_id: true,
  body: true,
  private: true,
  mentions: true,
  created_at: true,
  attachments: { select: { upload_id: true, position: true }, orderBy: { position: 'asc' } },
} as const;

export interface PostInput {
  conversationId: string;
  authorType: 'operator' | 'player' | 'system';
  authorId: string | null;
  body: string;
  isPrivate: boolean;
  mentions: string[];
  /** Feature 016 — already validated and CLAIMED by the caller before this is reached (research R8). */
  uploadIds?: string[];
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

  /**
   * Write the message and, when the caller supplied already-claimed uploads, its attachment rows —
   * in ONE batch `$transaction` (feature 016, T037).
   *
   * ── Why the batch form, and why the id is generated here ───────────────────────────────────────
   * The batch form is the one that CANNOT reproduce feature 013's live-only defect: there is no
   * `$transaction` pulled into a variable to lose its `this` on. It also cannot reference a row it is
   * about to create, which is why the message id is generated up front — that turns two dependent
   * writes into two independent statements, which is exactly what makes the safe form usable here.
   *
   * Validation is NOT done here. Everything that can refuse has already run (research R8 / the 013
   * ordering discipline), so by the time this executes the only possible outcome is both rows or
   * neither.
   */
  async post(accountId: string, input: PostInput): Promise<MessageRow> {
    const db = this.prisma.forAccount(accountId);
    const data = {
      account_id: accountId, // also injected by the scoped client; set explicitly for the type
      conversation_id: input.conversationId,
      author_type: input.authorType,
      author_id: input.authorId,
      body: input.body,
      private: input.isPrivate,
      // mentions are meaningful only on a private note (R6); empty otherwise.
      mentions: input.isPrivate ? input.mentions : [],
    };

    const uploadIds = [...new Set(input.uploadIds ?? [])];
    if (uploadIds.length === 0) {
      return (await db.message.create({ data, select: MESSAGE_SELECT })) as MessageRow;
    }

    const messageId = randomUUID();
    const [row] = (await db.$transaction([
      db.message.create({ data: { id: messageId, ...data }, select: MESSAGE_SELECT }),
      db.messageAttachment.createMany({
        data: uploadIds.map((upload_id, position) => ({
          account_id: accountId,
          message_id: messageId,
          upload_id,
          position,
        })),
      }),
    ] as never)) as unknown as [MessageRow];
    return row;
  }
}
