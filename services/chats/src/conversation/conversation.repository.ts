import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { Metadata } from '@grpc/grpc-js';
import { TransitionRecorder } from '../transition/transition.recorder';
import {
  statusChanged,
  subjectSet,
  TRANSITION_BEFORE_SELECT,
  type ConversationBefore,
  type TransitionActor,
} from '../transition/conversation-transitions';

/** Prisma types an interactive $transaction callback as a narrowed client; the cast is on the
 * CLIENT, never on the method — pulling $transaction into a variable loses `this` (feature 013). */
/** The slice of a transaction client these writes touch — narrow on purpose, so a future write to
 * some other table has to widen it deliberately rather than inherit `any`. */
interface TransactionScope {
  conversation: {
    findFirst(args: unknown): Promise<ConversationBefore | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  conversationTransition: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

interface TxCapableClient {
  $transaction<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T>;
}
import type { SubjectSource } from '../subject/subject.derive';
import type { OrderedCursor } from '../shared/cursor';
import { keysetPredicate, orderByFor, sortKeyOf, type OrderPart } from './order-parts';
import { priorityWrite, urgencyOrderParts } from './urgency';

/**
 * The orders the conversation list can be asked for (feature 029, roadmap 9.2).
 *
 * ⚠️ BOTH sort on `updated_at`. There is no `last_activity_at` column — the wire field of that name is
 * `updated_at` renamed, and checking the TABLE rather than the contract is what caught it (research
 * R7). Consequently the screen labels this "Updated", never "last activity": our own relabelling and
 * resolving bump the value, so the second name would claim customer contact that never happened.
 *
 * ⭐ **Feature 031 adds the third order that 029 refused.** The comment here used to read *"there is
 * deliberately NO urgency order — nothing computes urgency (roadmap 4.20 is unbuilt), and a sort asserting
 * a property the data lacks is a wrong answer nobody can see by looking."* 4.20 is this feature; the rank
 * now exists and is maintained (`urgency.ts`), so the order says something true. The refusal was right, and
 * lifting it required building the thing rather than renaming a sort.
 */
export type ConversationOrderKey =
  | 'created_desc'
  | 'updated_desc'
  | 'updated_asc'
  | 'urgency_desc';

/**
 * ⚠️ The REPOSITORY default is the pre-029 behaviour, and deliberately so.
 *
 * `list()` is shared by the player feed, the person feed and the CSV export, none of which asked for
 * a new order. Making `updated_desc` the repository default would have re-ordered all three silently
 * — the compiler said nothing, because they simply omit the field. It surfaced only because the
 * cursor type changed underneath them and TypeScript enumerated the call sites.
 *
 * ⇒ Callers that never chose an order keep the one they had. The INBOX chooses `updated_desc`
 * explicitly, at its own edge (`DEFAULT_INBOX_ORDER`), which is the only place the choice was made.
 */
export const DEFAULT_CONVERSATION_ORDER: ConversationOrderKey = 'created_desc';

/** What `ListConversations` uses when the caller names no order (feature 029, FR-002). */
export const DEFAULT_INBOX_ORDER: ConversationOrderKey = 'updated_desc';

/**
 * Every order the server implements, as an ordered list of key parts (`id` is appended by
 * {@link orderByFor}). Exported so the tests can assert the whole set — and so nothing else has to
 * restate it.
 *
 * ⚠️ The `orderBy` and the cursor predicate are BOTH derived from these parts (see `order-parts.ts`).
 * They cannot drift apart, which for a two-column order is not a tidiness point: a predicate that
 * disagrees with the sort produces a plausible page two with rows repeated and rows missing.
 */
export const ORDERS: Record<ConversationOrderKey, readonly OrderPart[]> = {
  created_desc: [{ column: 'created_at', direction: 'desc', type: 'time' }],
  updated_desc: [{ column: 'updated_at', direction: 'desc', type: 'time' }],
  updated_asc: [{ column: 'updated_at', direction: 'asc', type: 'time' }],
  // Feature 031 (FR-019/FR-020): the stored rank, then the longest wait. See `urgency.ts` for why the
  // rank holds no time and therefore cannot go stale.
  urgency_desc: urgencyOrderParts(),
};

export function isConversationOrderKey(v: string): v is ConversationOrderKey {
  return Object.prototype.hasOwnProperty.call(ORDERS, v);
}
import type { ConversationDetailRow, ConversationSummaryRow } from '../shared/wire';

const SUMMARY_SELECT = {
  id: true,
  brand_id: true,
  player_id: true,
  // ⭐ Feature 032 (roadmap 4.16): the status's CATEGORY, joined from the account's catalogue.
  //
  // On the SUMMARY and not only the detail, because the category is what a list may branch on — a badge
  // colour, a group header, the Archive's grouping. Selected here rather than resolved per-controller so
  // that every read path (inbox, player feed, person feed, export production) gets it without each
  // remembering to; a read that forgot would project UNSPECIFIED and look merely unlabelled.
  //
  // ⓘ Nine rows on a unique key. Prisma issues one extra query per page for it, which is the cost of not
  // denormalizing a category onto the largest table in the system, where it could then disagree.
  status_def: { select: { category: true } },
  status: true,
  priority: true,
  assignee_operator_id: true,
  channel: true,
  created_at: true,
  updated_at: true,
  // Feature 023 (roadmap 4.18): the title rides the SUMMARY, because the list is what it exists to fix.
  subject: true,
  // Feature 031: selected because the URGENCY order's page token has to carry it — a cursor cannot name
  // a row's position in a sequence whose leading column the query did not read. Not on the wire.
  priority_rank: true,
} as const;

const DETAIL_SELECT = {
  ...SUMMARY_SELECT,
  reference: true,
  category: true,
  sub_category: true,
  classified_by: true,
  // …and the SOURCE rides the detail only: the list does not need to know how a title was set, and
  // this is the widest-fanout query in the product.
  subject_source: true,
  // Feature 024 (roadmap 5.3): WHICH DESK took the work. Detail-only for the same reason — it is an
  // automation-scope input and a card fact, not a column the inbox list renders.
  routed_group_id: true,
  // ── Feature 033 (roadmap 6.1) — detail-only, like the two above ─────────────────────────────────
  //
  // ⚠️ `identity_state` is a CARD fact, not a list column: the Inbox shows a player name or a dash, and
  // W9's unidentified queue narrows by the indexed predicate rather than by reading this on every row of
  // the widest-fanout query in the product.
  identity_state: true,
  continues_conversation_id: true,
} as const;

export interface ListFilters {
  /**
   * ⭐ Feature 032 (roadmap 4.16): the status keys this page may contain.
   *
   * A LIST rather than one value, because the two filters the caller can send collapse into the same
   * predicate: `status_key` contributes one key, `status_category` contributes the account's keys in that
   * category, and asking for both means the intersection. Resolved at the controller — the repository
   * never reads the catalogue, so it cannot answer a question about a status the caller did not name.
   *
   * ⚠️ `[]` means "no configured status satisfies the ask" and must yield an EMPTY page, exactly as
   * `idIn: []` does. `undefined` means no status filter at all.
   */
  statusIn?: string[];
  priority?: string;
  assigneeOperatorId?: string;
  playerId?: string;
  /**
   * Feature 014 (R10): restrict to these conversation ids — the `sla_outcome` filter, resolved by the
   * SLA repository into an id set. `[]` means "no conversation has that outcome", which must yield an
   * EMPTY page rather than an unfiltered one.
   */
  idIn?: string[];
  /** Brand restriction: undefined = none; [] = deliberately empty (permitted set excludes the ask). */
  brandIn?: string[];
  /**
   * Feature 022 (roadmap 4.13) — the conversations of a PERSON: every `(brand, player)` pair that makes
   * up one human, resolved from `users` (never inferred from a matching id — that merge was the 5.2
   * defect). `[]` means "this person has no members", which must yield an EMPTY page rather than an
   * unfiltered one, exactly as `idIn: []` does.
   *
   * ONE query with an `OR` over the pairs, not one per member: every conversation lives in this database,
   * so the union is a single indexed read. The k-way merge feature 015 uses exists because those rows sit
   * in three separate databases (research R6).
   */
  membersIn?: Array<{ brandId: string; playerId: string }>;
  /**
   * ⭐ Feature 030 (roadmap 4.14) — the AM's portfolio **SCOPE**, not a filter.
   *
   * ⚠️ **The difference is the whole point, and it is why this is a separate field from `membersIn`.**
   * A filter narrows what the caller ASKED FOR; a scope narrows what they are ALLOWED to ask for
   * (ADR 0038 §1's distinction). So this is `AND`-ed with every other predicate and can only ever
   * remove rows — writing it into `membersIn` would let one clobber the other, and which one won would
   * depend on statement order.
   *
   * `undefined` = this caller is not portfolio-scoped (an administrator, or a role that never sees the
   * `am_only` tier). An **empty array** is a real, different answer: *"attached to nobody"*, which
   * matches nothing.
   *
   * ⚠️ Pairs, never bare player ids: the same platform id under two brands is routinely two different
   * human beings (feature 020 / ADR 0038 §3).
   */
  portfolioIn?: ReadonlyArray<{ brandId: string; playerId: string }>;
  /**
   * Feature 029: the arrival channel. ⚠️ `undefined` means NO FILTER — it must never come to mean
   * "conversations that have no channel". ~1 in 6 rows have none, and a `channel: null` predicate
   * hiding them would remove a fifth of the queue from the default view without looking broken.
   */
  channel?: string;
  /**
   * W5 (roadmap 4.19): only conversations this operator has a read mark on — the "he opened it" leg
   * of the agent rail. An EXISTS over the relation, so the cost is one index probe per row.
   *
   * ⓘ The nested predicate names no account: the parent row is already under `forAccount`, and a mark
   * can only ever carry its conversation's own account (the write path derives one from the other).
   */
  openedByOperatorId?: string;
  /** Feature 029: defaults to `updated_desc`. See ORDERS above for why there is no urgency order. */
  order?: ConversationOrderKey;
  limit: number;
  cursor: OrderedCursor | null;
}

export interface CreateInput {
  brandId: string;
  playerId?: string;
  priority?: string;
  channel?: string;
  assigneeOperatorId?: string;
  // ── Feature 033 (roadmap 6.1) — additive, all optional so every existing caller is unchanged ─────
  /**
   * The status key this conversation starts in.
   *
   * ⚠️ **Absent means the column default (`open`), which is right for a seed and WRONG for an intake.**
   * FR-016 requires an arriving ticket to take a key from the account's own catalogue in the `new`
   * category — the intake service resolves it and passes it here. The default is left in place rather
   * than removed because the seed and the test fixtures legitimately rely on it, and because a required
   * argument would make every existing caller state a status it does not care about.
   */
  status?: string;
  /** `identified` | `unidentified`. Stored, never derived from an empty `playerId` (ADR 0044 §1). */
  identityState?: string;
  /** Opaque handle to the users-side envelope. chats never holds an address (FR-021b). */
  channelParticipantId?: string;
  /** Set when a reply on a CLOSED thread produced this ticket (FR-029b). */
  continuesConversationId?: string;
  /**
   * A title the SOURCE gave — an email's `Subject` header (FR-028).
   *
   * ⚠️ Passed together with `subjectSource: 'source'` and never alone. A title with a NULL source would
   * leave the 4.18 derivation window open over a title that already exists, and the window's close would
   * then overwrite the customer's own words with our summary of them. Empty/absent leaves both NULL,
   * which is the correct reading of an empty `Subject`: the source gave no title, so our window stays
   * open — as opposed to a stored `''`, which would be a title that is blank for ever.
   */
  subject?: string;
  subjectSource?: SubjectSource;
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
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransitionRecorder) private readonly transitions: TransitionRecorder,
  ) {}

  async list(
    accountId: string,
    f: ListFilters,
  ): Promise<{ rows: ConversationSummaryRow[]; nextCursor: OrderedCursor | null }> {
    const orderKey = f.order ?? DEFAULT_CONVERSATION_ORDER;
    const parts = ORDERS[orderKey];

    const where: Record<string, unknown> = {};
    // Feature 032: `in` even for a single key, so "one status" and "a category's statuses" are one
    // predicate. An empty list narrows to nothing rather than widening to everything (the 012 lesson).
    if (f.statusIn) where.status = { in: f.statusIn };
    if (f.priority) where.priority = f.priority;
    if (f.assigneeOperatorId) where.assignee_operator_id = f.assigneeOperatorId;
    if (f.playerId) where.player_id = f.playerId;
    if (f.channel) where.channel = f.channel;
    if (f.openedByOperatorId)
      where.read_marks = { some: { operator_id: f.openedByOperatorId } };
    if (f.brandIn) where.brand_id = { in: f.brandIn };
    if (f.idIn) where.id = { in: f.idIn };
    if (f.membersIn) {
      // A person with no members matches NOTHING. Expressed as `id: { in: [] }` rather than `OR: []`,
      // because an empty `OR` is a Prisma detail one refactor away from meaning "no restriction" — and
      // "no restriction" here would return the whole account.
      if (f.membersIn.length === 0) where.id = { in: [] };
      else
        where.OR = f.membersIn.map((m) => ({ brand_id: m.brandId, player_id: m.playerId }));
    }

    /**
     * Everything that must hold **in addition** to the filters above, accumulated rather than assigned.
     *
     * ⚠️ The cursor clause used to assign `where.AND` outright. With a second conjunct to add (the
     * portfolio scope) that assignment would silently drop whichever landed first — and dropping the
     * SCOPE is the direction that returns other people's conversations, with no error anywhere.
     */
    const and: unknown[] = [];

    if (f.portfolioIn) {
      // Attached to nobody matches NOTHING. Expressed as `id: { in: [] }` for the same reason
      // `membersIn` does it: an empty `OR` is a Prisma detail one refactor away from meaning "no
      // restriction", and "no restriction" here would hand over the whole account.
      if (f.portfolioIn.length === 0) and.push({ id: { in: [] } });
      else
        and.push({
          OR: f.portfolioIn.map((m) => ({ brand_id: m.brandId, player_id: m.playerId })),
        });
    }

    if (f.cursor) {
      // ⭐ The keyset predicate MUST name the same columns and directions as the `orderBy` below. If they
      // ever disagree, page two is drawn from a different sequence than page one — and the result is not
      // an error but a plausible list with rows repeated and rows missing. Feature 031: both are now
      // GENERATED from the one `ORDERS` entry, because the urgency order has two columns and the
      // hand-written version of that predicate is three clauses no review can check.
      and.push(keysetPredicate(parts, f.cursor.sortKey, f.cursor.id));
    }

    if (and.length > 0) where.AND = and;

    const rows = (await this.prisma.forAccount(accountId).conversation.findMany({
      where,
      // The tie-breaker follows the INNERMOST part's direction: a stable keyset needs the ordering to
      // point one way at the level it compares, or the `id` comparison above contradicts the sort.
      orderBy: orderByFor(parts),
      take: f.limit + 1,
      select: SUMMARY_SELECT,
    })) as ConversationSummaryRow[];

    const hasMore = rows.length > f.limit;
    const kept = hasMore ? rows.slice(0, f.limit) : rows;
    const last = kept[kept.length - 1];
    const nextCursor =
      hasMore && last
        ? { sortKey: sortKeyOf(last as unknown as Record<string, unknown>, parts), id: last.id, order: orderKey }
        : null;
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
        // Feature 031: the word and its rank together, always — see `urgency.ts` and the structural
        // guard that fails when any path writes the column by hand.
        ...priorityWrite(input.priority),
        channel: input.channel ?? null,
        assignee_operator_id: input.assigneeOperatorId ?? null,
        // Feature 033. `status` is spread conditionally so an absent value keeps the column DEFAULT
        // rather than writing `undefined` — Prisma treats an explicit `undefined` as "no value", but
        // spelling it out here would invite a future edit to pass `null`, which the composite foreign
        // key would then refuse at the moment a customer's message arrived.
        ...(input.status !== undefined ? { status: input.status } : {}),
        identity_state: input.identityState ?? null,
        channel_participant_id: input.channelParticipantId ?? null,
        continues_conversation_id: input.continuesConversationId ?? null,
        // Feature 033 (FR-028). Both or neither: a title with no source would leave the derivation
        // window open over it, and closing that window would overwrite the customer's own subject line.
        ...(input.subject && input.subjectSource
          ? { subject: input.subject, subject_source: input.subjectSource }
          : {}),
      },
      select: DETAIL_SELECT,
    })) as ConversationDetailRow;
  }

  /**
   * Set status; returns the updated row, or null when the id is not in this account.
   *
   * ── Feature 023: the change and its transition land together, or neither lands ─────────────────
   * `actor` is REQUIRED, not optional. An optional parameter would have let every existing call site
   * keep compiling while silently recording nothing — the gap this whole feature exists to prevent.
   * Feature 020 made the same choice with the composite key for the same reason: 16 stale call sites
   * that FAIL TO COMPILE are worth more than zero errors and a silent hole.
   *
   * The `before` read is inside the transaction, so `from` is the value this update actually replaced.
   */
  async setStatus(
    accountId: string,
    id: string,
    /** Feature 032: a status KEY the caller has already resolved against the account's catalogue. */
    status: string,
    actor: TransitionActor,
    metadata?: Metadata,
  ): Promise<ConversationDetailRow | null> {
    const db = this.prisma.forAccount(accountId) as unknown as TxCapableClient;

    // Called as a method so `this` stays the Prisma client — feature 013 lost that binding by pulling
    // `$transaction` into a variable, and every auto-assign 500ed.
    const changed = await db.$transaction(async (tx) => {
      const before = await tx.conversation.findFirst({
        where: { id },
        select: TRANSITION_BEFORE_SELECT,
      });
      if (!before) return false;

      const res = await tx.conversation.updateMany({ where: { id }, data: { status } });
      if (res.count === 0) return false;

      await this.transitions.record(
        tx,
        statusChanged(accountId, before, status, actor, new Date(), metadata),
      );
      return true;
    });

    if (!changed) return null;
    return this.getById(accountId, id);
  }

  /**
   * ⭐ Correct which BRAND a conversation belongs to (feature 032, roadmap 4.16 — R22, amends ADR 0038).
   *
   * ── Why this write is audited and the status write is not ────────────────────────────────────────
   * A status is the everyday shape of the work and changes many times a day; brand is the record's
   * IDENTITY. It decides which reports the conversation appears in and which brand's history it becomes
   * part of, so a silent correction rewrites past numbers with nothing to point at. ADR 0019's store
   * exists for exactly that class of act.
   *
   * The entry is a STATEMENT inside this transaction, never an `append()` beside it: the change and its
   * trail land together or neither lands (feature 015's FR-009). `auditStatement` is built by the caller,
   * because validation of an audit detail must happen BEFORE the transaction opens — a refused entry
   * means the update never starts rather than being rolled back.
   *
   * ── No transition, deliberately ─────────────────────────────────────────────────────────────────
   * R22 asks for accountability, which is the audit trail. A second `conversation.brand_changed` type in
   * the transition catalogue would have no reader — the *written-with-nobody-to-read-it* shape this
   * project already shipped once, when the audit log ran for five features with no screen.
   *
   * ── The caller must have read the row first ─────────────────────────────────────────────────────
   * Same contract as `automations.repository.ts#removeAudited`, for the same reason: `updateMany` reports
   * a count of 0 for an id that is not there and the transaction still commits, so calling this blind
   * would file an entry for a change that never happened. A trail that records non-events is worse than
   * one with a gap — a reader cannot tell the difference. Hence: read, refuse, then update+record.
   */
  async setBrand(
    accountId: string,
    id: string,
    brandId: string,
    auditStatement: unknown,
  ): Promise<number> {
    const db = this.prisma.forAccount(accountId);
    const [res] = (await db.$transaction([
      db.conversation.updateMany({ where: { id }, data: { brand_id: brandId } }),
      auditStatement,
    ] as never)) as unknown as [{ count: number }];
    return res.count;
  }

  /**
   * Set the title BY HAND, and lock it (feature 023, roadmap 4.18 — FR-022 / U9).
   *
   * ── Why the lock is the write and not a flag beside it ──────────────────────────────────────────
   * `subject_source = 'manual'` is set in the SAME statement as the title, so there is no instant at
   * which a human's wording sits in the column without the mark that protects it. Every automated
   * writer — the derivation, the sweep, a macro — checks that mark first and refuses (FR-022), and the
   * refusal is a predicate rather than a policy: `decideSubject` returns null and the sweep's
   * `subject_source: null` `where` matches zero rows.
   *
   * ── Idempotent by predicate, not by comparison ──────────────────────────────────────────────────
   * There is no "did the value actually change" check. Setting the same title twice records two
   * transitions, and that is correct: each is a real act by a real person at a real time, and the
   * question the stream answers is *who named this and when*, not *how many distinct strings existed*.
   */
  async setSubject(
    accountId: string,
    id: string,
    subject: string,
    actor: TransitionActor,
    metadata?: Metadata,
  ): Promise<ConversationDetailRow | null> {
    const db = this.prisma.forAccount(accountId) as unknown as TxCapableClient;

    const changed = await db.$transaction(async (tx) => {
      const before = await tx.conversation.findFirst({
        where: { id },
        select: TRANSITION_BEFORE_SELECT,
      });
      if (!before) return false;

      const res = await tx.conversation.updateMany({
        where: { id },
        // No `subject_source` predicate here, deliberately: a person may rename a conversation another
        // person named. The lock is against AUTOMATION, not against people.
        data: { subject, subject_source: 'manual' },
      });
      if (res.count === 0) return false;

      await this.transitions.record(
        tx,
        subjectSet(accountId, before, 'manual', actor, new Date(), metadata),
      );
      return true;
    });

    if (!changed) return null;
    return this.getById(accountId, id);
  }
}
