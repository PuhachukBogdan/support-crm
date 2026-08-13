import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { Cursor } from '../shared/cursor';
import type { MessageRow, Projection } from '../shared/wire';
import { decideContactStamp } from './contact-stamp';
import { TransitionRecorder } from '../transition/transition.recorder';
import { OutboundRepository } from '../channel/outbound.repository';
import {
  firstPublicReplyBase,
  subjectSet,
  TRANSITION_BEFORE_SELECT,
  type ConversationBefore,
  type TransitionActor,
} from '../transition/conversation-transitions';
import {
  CLOSING_PLAYER_MESSAGE_COUNT,
  decideSubject,
  type AttachmentKind,
} from '../subject/subject.derive';

/**
 * The slice of the transaction client `post` uses (feature 022).
 *
 * Prisma types an interactive `$transaction` callback as `Omit<PrismaClient, …>`, which does not carry
 * our `$extends` account scoping in its *type* even though it does at *runtime* (the extension wraps
 * every operation). Rather than fight that, declare exactly the delegates we touch and go through one
 * narrow, documented cast — the approach `assignment/round-robin-state.repository.ts` already takes.
 */
interface MessageTx {
  message: {
    create(args: unknown): Promise<unknown>;
    // Feature 023 (T030): how many CUSTOMER messages this conversation has, to close the title window.
    count(args: unknown): Promise<number>;
  };
  conversation: {
    updateMany(args: unknown): Promise<unknown>;
    // Feature 023: the before-row — first-public-reply and the title window both read it.
    findFirst(args: unknown): Promise<MessageBeforeRow | null>;
  };
  messageAttachment: { createMany(args: unknown): Promise<unknown> };
  conversationTransition: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
  // Feature 033: which channel row this brand's email goes out on, and the intent to deliver.
  channel: { findFirst(args: unknown): Promise<unknown> };
  outboundMessage: { create(args: { data: Record<string, unknown> }): Promise<unknown> };
}

/** The conversation columns this write path reads before touching anything. */
type MessageBeforeRow = ConversationBefore & {
  last_outbound_at: Date | null;
  subject: string | null;
  subject_source: string | null;
  category: string | null;
  /** Feature 033: the typed channel kind, or NULL for a ticket with no arrival channel. */
  channel: string | null;
};

const MESSAGE_BEFORE_SELECT = {
  ...TRANSITION_BEFORE_SELECT,
  last_outbound_at: true,
  subject: true,
  subject_source: true,
  category: true,
  // ⭐ Feature 033 (roadmap 6.5): which CHANNEL this ticket arrived on decides whether a public reply also
  // needs delivering. Read in the one `before` query the transaction already makes, rather than in a
  // second one — this is the busiest write path in the product (Principle VII).
  channel: true,
} as const;

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
  /**
   * Feature 023 (FR-017): the KIND of the first attachment, derived by the caller from the uploads it
   * already described (`attachmentKindOf`). Never a file name — the caller must not pass one, and the
   * title never holds one.
   *
   * ⚠️ **No caller sets this today, and that is correct, not an oversight.** A title is derived only
   * from CUSTOMER messages, and the only customer-authored write path is `RecordIncomingMessage`,
   * which carries no attachments — customer-side attachment ingestion arrives with the channels
   * (roadmap 6.1 / 6.4). The staff path does carry uploads, but a staff message closes the window
   * rather than naming it, so reading a kind there would be theatre.
   *
   * The seam ships now for the same reason the reserved catalogue types do: so the channel work adds
   * one argument instead of re-deriving the rule.
   */
  attachmentKind?: AttachmentKind | null;
  /**
   * Feature 033 (roadmap 6.4): this message's identity ON ITS CHANNEL — an email's `Message-ID`.
   *
   * ⚠️ **Written on the way IN and on the way OUT, and both are required for threading to work at all.**
   * A customer's reply quotes the identifier we put on the message weeks earlier; if it was not stored
   * then, there is nothing to match and the thread splits with no way back (`threading.ts`).
   *
   * Absent for every other write path — an agent's note, a widget message, a seeded row. The column is
   * `@@unique([account_id, external_id])` and Postgres treats NULLs as distinct, so those coexist; the
   * constraint is what makes "the same inbound email appears once" true (FR-032) rather than hoped for.
   */
  externalId?: string | null;
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
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransitionRecorder) private readonly transitions: TransitionRecorder,
    // Feature 033: the delivery intent shares this repository's transaction — see `enqueueDelivery`.
    @Inject(OutboundRepository) private readonly outbox: OutboundRepository,
  ) {}

  /** The conversation's brand (for the brand resource-check) — null when absent in this account. */
  async conversationBrand(accountId: string, conversationId: string): Promise<string | null> {
    const c = (await this.prisma.forAccount(accountId).conversation.findFirst({
      where: { id: conversationId },
      select: { brand_id: true },
    })) as { brand_id: string } | null;
    return c?.brand_id ?? null;
  }

  /** W27 / 036: the one fact PostMessage's shelf guard needs — lean, like `conversationBrand`. */
  async conversationShelved(accountId: string, conversationId: string): Promise<string | null> {
    const c = (await this.prisma.forAccount(accountId).conversation.findFirst({
      where: { id: conversationId },
      select: { shelved_state: true },
    })) as { shelved_state: string | null } | null;
    return c?.shelved_state ?? null;
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
  async post(
    accountId: string,
    input: PostInput,
    actor: TransitionActor,
  ): Promise<MessageRow> {
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
      // Feature 033. NULL for every path that has no channel identity — never `''`, which would be a
      // value and would therefore collide with the next blank under the unique constraint.
      external_id: input.externalId ?? null,
    };
    const uploadIds = [...new Set(input.uploadIds ?? [])];
    // ONE rule, one place (`contact-stamp.ts`): a private note and a system entry stamp nothing.
    const stampColumn = decideContactStamp(input.authorType, input.isPrivate);

    return db.$transaction(async (tx) => {
      // ── ONE read of the conversation's BEFORE-state, taken before any write in this transaction ───
      //
      // ⚠️ The ordering is load-bearing, and getting it wrong is silent. The stamp update below sets
      // `last_outbound_at`; a read taken after it can never observe the null that MEANS "this is the
      // first public reply", so the transition would simply never be recorded — with every unit test
      // still green, because a fake `findFirst` returns whatever it was told regardless of the
      // `updateMany` before it. Only a live run would have shown it.
      //
      // One read serves both concerns (first-public-reply and the title window) rather than two: the
      // row is the same row, and the message path is the busiest one in the product.
      const before = (await tx.conversation.findFirst({
        where: { id: input.conversationId },
        select: MESSAGE_BEFORE_SELECT,
      })) as MessageBeforeRow | null;

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

      // ── Feature 023 (roadmap 4.8a): the FIRST public reply is a transition ─────────────────────
      //
      // "Public" is NOT re-derived here. `decideContactStamp` above already owns that rule, and it is
      // the same rule the SLA clock uses — a third definition of "we replied" would drift, and the
      // drift is invisible until a card, an SLA report and the event stream disagree about one
      // conversation (the 022 lesson, stated in contact-stamp.ts).
      //
      // FIRST is decided by the column the stamp maintains: if `last_outbound_at` was null before this
      // write, this reply is the first one. No counting, no second source of truth.
      if (stampColumn === 'last_outbound_at' && before && !before.last_outbound_at) {
        await this.transitions.record(tx, {
          ...firstPublicReplyBase(accountId, before, actor, row.created_at),
          payload: { messageId: row.id },
        });
      }

      // ── Feature 023 (roadmap 4.18): the title window ───────────────────────────────────────────
      //
      // The decision is pure (`subject.derive.ts`); this only supplies the facts and writes the result.
      // Nothing here re-reads earlier message BODIES: the first substantive message becomes the
      // candidate as it arrives, so closing the window later needs only the count.
      if (before) {
        await this.closeOrAdvanceSubjectWindow(tx, accountId, input, before, row, actor);

        // ── ⭐ Feature 033 (roadmap 6.5): the delivery intent, in THIS transaction (FR-036) ────────
        //
        // ⚠️ **It must be this transaction and not the controller.** An intent written outside it can
        // exist without its message (a delivery of nothing) or, worse, the message can exist without the
        // intent — a customer who was answered and never told, invisible from inside the product.
        // Feature 028 established the same rule for identity mail, in the same words.
        //
        // Inside the `before` guard because the decision reads the conversation's CHANNEL. No before-row
        // means the conversation is not in this account, and the message write above will fail on the
        // foreign key regardless — enqueueing against it would be a row pointing at nothing.
        await this.enqueueDelivery(tx, accountId, input, before, row);
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

  /**
   * Write the delivery intent for a public operator reply on an email-channel ticket (feature 033, T063).
   *
   * ── The three conditions, and why each excludes what it excludes ────────────────────────────────
   *  · **`operator`** — a customer's own message needs no delivering, and a `system` entry is ours.
   *  · **not private** — a private note MUST NOT leave the building (FR-037 / SEC-13). This is the second
   *    place that rule is enforced, and deliberately so: the first is the projection, and a note that
   *    escaped by mail would be the same disclosure by a different door.
   *  · **an email channel** — the only kind with a transport in this build. `api` cannot carry a message
   *    out at all and `messenger` has no transport yet; both are refused by `canSend` one layer up, but
   *    enqueueing them here would build a queue of deliveries that can only ever fail.
   *
   * ⚠️ **A missing `Channel` row is silence, not an error.** A ticket may carry `channel = 'email'` from
   * the migration while its account has no channel configured — a seeded fixture, a deployment mid-setup.
   * Throwing would refuse the agent's message over a configuration gap that has nothing to do with it;
   * the reply is still recorded and readable, and nothing is queued for a transport that does not exist.
   */
  private async enqueueDelivery(
    tx: MessageTx,
    accountId: string,
    input: PostInput,
    before: MessageBeforeRow,
    row: MessageRow,
  ): Promise<void> {
    if (input.authorType !== 'operator' || input.isPrivate) return;
    if (before.channel !== 'email') return;

    const channel = (await tx.channel.findFirst({
      where: { brand_id: before.brand_id, kind: 'email', enabled: true },
      select: { id: true },
    })) as { id: string } | null;
    if (!channel) return;

    await this.outbox.enqueue(tx, {
      accountId,
      conversationId: input.conversationId,
      messageId: row.id,
      channelId: channel.id,
    });
  }

  /**
   * Advance or close the title window for this message (FR-014…FR-019, T030/T030a).
   *
   * ── The count, and why it is not free but is still cheap ────────────────────────────────────────
   * Only the customer's 3rd message closes the window by count, so the count is read ONLY while the
   * window is open and only for a customer message — that is a handful of rows on a conversation that
   * is minutes old, on the `(conversation_id, created_at)` index. On every other post (a staff reply,
   * a private note, any message on a conversation whose title is already fixed) it is not read at all,
   * and the frozen check runs first precisely so the common path costs nothing.
   *
   * ── `updateMany` with the window predicate, not a bare id ───────────────────────────────────────
   * The `where` repeats `subject_source: null`, so two concurrent messages cannot both close the
   * window: the second matches zero rows. The scoped client injects `account_id`, which composes with
   * a filter and not with a unique-id lookup — the pattern every write here uses.
   */
  private async closeOrAdvanceSubjectWindow(
    tx: MessageTx,
    accountId: string,
    input: PostInput,
    before: MessageBeforeRow,
    row: MessageRow,
    actor: TransitionActor,
  ): Promise<void> {
    // Frozen — the overwhelmingly common case. Truthiness, not `!== null`: an absent column reads as
    // `undefined` through a narrowed select and both mean "no source recorded"; `auto` and `manual`
    // are the only legal values and both are truthy.
    if (before.subject_source) return;

    let playerMessageCount = 0;
    if (input.authorType === 'player' && !input.isPrivate) {
      playerMessageCount = await tx.message.count({
        where: { conversation_id: input.conversationId, author_type: 'player', private: false },
        take: CLOSING_PLAYER_MESSAGE_COUNT, // the exact number is irrelevant past the threshold
      });
    }

    const change = decideSubject(
      {
        subject: before.subject ?? null,
        subject_source: before.subject_source ?? null,
        category: before.category ?? null,
      },
      {
      authorType: input.authorType,
      isPrivate: input.isPrivate,
      body: input.body,
        attachmentKind: input.attachmentKind ?? null,
        playerMessageCount,
      },
    );
    if (!change) return;

    await tx.conversation.updateMany({
      where: { id: input.conversationId, subject_source: null },
      data: change,
    });

    // The transition is recorded only when the window CLOSES — while it is open the title is a
    // candidate, not a decision, and recording each candidate would report a title being "set"
    // several times for one conversation.
    if (change.subject_source) {
      await this.transitions.record(
        tx,
        subjectSet(accountId, before, change.subject_source, actor, row.created_at),
      );
    }
  }
}
