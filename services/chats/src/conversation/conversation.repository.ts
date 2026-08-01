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
  // Feature 023 (roadmap 4.18): the title rides the SUMMARY, because the list is what it exists to fix.
  subject: true,
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
} as const;

export interface ListFilters {
  status?: DbStatus;
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
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransitionRecorder) private readonly transitions: TransitionRecorder,
  ) {}

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
    if (f.idIn) where.id = { in: f.idIn };
    if (f.membersIn) {
      // A person with no members matches NOTHING. Expressed as `id: { in: [] }` rather than `OR: []`,
      // because an empty `OR` is a Prisma detail one refactor away from meaning "no restriction" — and
      // "no restriction" here would return the whole account.
      if (f.membersIn.length === 0) where.id = { in: [] };
      else
        where.OR = f.membersIn.map((m) => ({ brand_id: m.brandId, player_id: m.playerId }));
    }

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
    status: DbStatus,
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
