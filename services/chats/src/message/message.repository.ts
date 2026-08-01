import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { Cursor } from '../shared/cursor';
import type { MessageRow, Projection } from '../shared/wire';
import { decideContactStamp } from './contact-stamp';

/**
 * The slice of the transaction client `post` uses (feature 022).
 *
 * Prisma types an interactive `$transaction` callback as `Omit<PrismaClient, …>`, which does not carry
 * our `$extends` account scoping in its *type* even though it does at *runtime* (the extension wraps
 * every operation). Rather than fight that, declare exactly the delegates we touch and go through one
 * narrow, documented cast — the approach `assignment/round-robin-state.repository.ts` already takes.
 */
interface MessageTx {
  message: { create(args: unknown): Promise<unknown> };
  conversation: { updateMany(args: unknown): Promise<unknown> };
  messageAttachment: { createMany(args: unknown): Promise<unknown> };
}

/**
 * The scoped client, narrowed to the interactive-transaction signature.
 *
 * ⚠️ NOTE: the cast is on the **client**, not on the method. Pulling `$transaction` out into a variable
 * loses its `this` binding and Prisma then dies on `this._engineConfig` — a failure only a live run
 * shows, because a unit-test fake is a standalone function that never needed `this` (feature 013's
 * live-only defect). Always call it as `client.$transaction(...)`.
 */
interface TxCapableClient {
  $transaction<T>(fn: (tx: MessageTx) => Promise<T>): Promise<T>;
}

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
   * Write the message, the conversation's contact stamp, and (when the caller supplied already-claimed
   * uploads) its attachment rows — in ONE interactive `$transaction`.
   *
   * ── Why the form changed in feature 022, and why that is not a step backwards ───────────────────
   * Feature 016 used the BATCH form deliberately: it cannot reproduce feature 013's live-only defect
   * (a `$transaction` pulled into a variable loses its `this` and Prisma dies on `this._engineConfig`),
   * and it cannot reference a row it is about to create — which is why the message id used to be
   * generated up front.
   *
   * Feature 022 needs something the batch form cannot express: the conversation's `last_inbound_at` /
   * `last_outbound_at` must be set to **the created message's own `created_at`**, which only exists
   * after the insert. So the callback form is used, exactly as
   * `assignment/round-robin-state.repository.ts` already does for its read-modify-write, with the same
   * discipline: `db.$transaction(...)` is called **on the client**, never destructured — that, not the
   * batch shape, is what 013's defect was actually about.
   *
   * With a row id available inside the transaction, generating one up front is no longer needed. The
   * constraint that shaped that code is gone, so the code follows.
   *
   * ── Why the stamp lives HERE and not beside the SLA call ────────────────────────────────────────
   * The first-reply clock is driven from the controller AFTER this method returns, outside its
   * transaction. That is tolerable for the SLA because the sweep re-derives from Postgres. Nothing
   * re-derives the contact stamp, so a crash between two separate writes would leave a message the
   * player card cannot see — the exact wrong answer this feature exists to prevent. One transaction, or
   * the guarantee is a hope.
   *
   * Validation is NOT done here. Everything that can refuse has already run (research R8 / the 013
   * ordering discipline), so by the time this executes the only possible outcome is every row or none.
   */
  async post(accountId: string, input: PostInput): Promise<MessageRow> {
    const db = this.prisma.forAccount(accountId) as unknown as TxCapableClient;
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
    // ONE rule, one place (`contact-stamp.ts`): a private note and a system entry stamp nothing.
    const stampColumn = decideContactStamp(input.authorType, input.isPrivate);

    return db.$transaction(async (tx) => {
      const row = (await tx.message.create({ data, select: MESSAGE_SELECT })) as MessageRow;

      if (stampColumn) {
        // `updateMany`, not `update`: the scoped client injects an `account_id` predicate, which
        // composes with a filter and not with a unique-id lookup (the pattern every write here uses).
        // The value is the row's OWN timestamp, so "the column equals what the messages say" is an
        // equality by construction rather than a tolerance — see research R2.
        await tx.conversation.updateMany({
          where: { id: input.conversationId },
          data: { [stampColumn]: row.created_at },
        });
      }

      if (uploadIds.length > 0) {
        await tx.messageAttachment.createMany({
          data: uploadIds.map((upload_id, position) => ({
            account_id: accountId,
            message_id: row.id,
            upload_id,
            position,
          })),
        });
      }

      return row;
    });
  }
}
