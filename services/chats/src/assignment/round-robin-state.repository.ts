import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { TransitionRecorder } from '../transition/transition.recorder';
import {
  assigned,
  type ConversationBefore,
  systemActor,
  TRANSITION_BEFORE_SELECT,
} from '../transition/conversation-transitions';
import { selectRoundRobin, type RoundRobinCandidate } from './round-robin';
import { unitsUsed } from './capacity';
import { StatusRepository } from '../status/status.repository';

/**
 * Feature 032: the statuses that count as work in hand come from the ACCOUNT — the same set the pool
 * counts, and still one definition with two readers (`StatusRepository.nonTerminalKeys`). See
 * `group-pool.ts` for why the old literal `['open','pending']` under-counted real work.
 */

export interface AutoAssignOutcome {
  operatorId: string | null;
}

/**
 * The slice of the transaction client this repository uses.
 *
 * Prisma types an interactive `$transaction` callback as `Omit<PrismaClient, …>`, which does not
 * carry our `$extends` account scoping in its *type* even though it does at *runtime* (the extension
 * wraps every operation). Rather than fight that, we declare exactly the delegates we touch and go
 * through one narrow, documented cast — the same approach `withAccountScope` itself uses.
 */
interface WorkflowTx {
  roundRobinState: {
    findFirst(args: unknown): Promise<{ id: string; last_operator_id: string | null } | null>;
    updateMany(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
  };
  conversation: {
    // Feature 023: the transition needs the row as it was BEFORE the assignment, read inside the
    // same transaction so `from` is the value this write actually replaced.
    findFirst(args: unknown): Promise<ConversationBefore | null>;
    // Feature 031: what this operator is holding, re-read INSIDE the lock — see `selectAndAssign`.
    findMany(args: unknown): Promise<{ channel: string | null }[]>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  conversationTransition: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
  /**
   * Feature 031: the per-operator advisory lock, and the ONLY raw statement in this service's write
   * paths. It touches no tenant table — it takes a lock on a hashed string — so it neither needs nor
   * bypasses the account scope; the account is part of the key so two accounts never contend.
   */
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}

/**
 * The scoped client, narrowed to the interactive-transaction signature we need.
 *
 * NOTE: the cast is on the **client**, not on the method. Pulling `$transaction` out into a variable
 * loses its `this` binding and Prisma then dies on `this._engineConfig` — a failure only a live run
 * shows, because a unit-test fake is a standalone function that never needed `this`. Always call it
 * as `client.$transaction(...)`.
 */
interface TxCapableClient {
  $transaction(fn: (tx: WorkflowTx) => Promise<AutoAssignOutcome>): Promise<AutoAssignOutcome>;
}

/**
 * Rotation state + the atomic "pick and assign" step (feature 013, US3 — roadmap 4.4 / research R3).
 * Account-scoped via `forAccount` (Principle I); rotation is keyed per `(account_id, group_key)`.
 *
 * The cursor advance and the assignment happen **inside one transaction**. That matters for the edge
 * case the spec calls out: two concurrent callers must not both be handed the same "next" operator
 * and silently push them past capacity. Serialising the read-modify-write of the cursor is what
 * makes the rotation fair under concurrency, not just sequentially.
 *
 * Explicit @Inject: the runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class RoundRobinStateRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransitionRecorder) private readonly transitions: TransitionRecorder,
    @Inject(StatusRepository) private readonly statuses: StatusRepository,
  ) {}

  /**
   * Who this desk served last, or `null` when the rotation has never run.
   *
   * ⚠️ A PERSON, not a position — see `round-robin.ts`. The previous index-based cursor meant a
   * different colleague after every log-on and log-off, which is unfairness no error message
   * describes.
   */
  async readCursor(accountId: string, groupKey: string): Promise<string | null> {
    const row = (await this.prisma.forAccount(accountId).roundRobinState.findFirst({
      where: { group_key: groupKey },
      select: { last_operator_id: true },
    })) as { last_operator_id: string | null } | null;
    return row?.last_operator_id ?? null;
  }

  /**
   * Select the next operator and, when one is available, assign it to the conversation — advancing
   * the persisted cursor in the same transaction.
   *
   * Returns `{ operatorId: null }` when nobody has capacity; in that case **nothing is written**:
   * the conversation keeps its current assignee and the cursor does not move.
   *
   * @param routedGroupId feature 024 — the GROUP the pool came from, recorded on the conversation in
   *        the same write as the assignee. `undefined` for the caller-supplied candidate path, which
   *        leaves the column untouched rather than writing a null over an earlier value: a later
   *        manual re-route must not erase which desk originally took the work.
   */
  async selectAndAssign(
    accountId: string,
    conversationId: string,
    groupKey: string,
    candidates: readonly RoundRobinCandidate[],
    routedGroupId?: string,
  ): Promise<AutoAssignOutcome> {
    const db = this.prisma.forAccount(accountId) as unknown as TxCapableClient;
    // Feature 032: read BEFORE the transaction — it is the account's configuration, not part of the
    // claim's serialisation, and holding the advisory lock while querying it would widen the lock for no
    // gain. A supervisor retiring a status mid-claim changes the next claim, not this one.
    const openStatuses = await this.statuses.nonTerminalKeys(accountId);

    // Called as a method so `this` stays the Prisma client (see TxCapableClient).
    return db.$transaction(async (tx) => {
      const existing = await tx.roundRobinState.findFirst({
        where: { group_key: groupKey },
        select: { id: true, last_operator_id: true },
      });

      const { operatorId, nextOperatorId } = selectRoundRobin(candidates, existing?.last_operator_id ?? null);
      if (operatorId === null) return { operatorId: null };

      /**
       * ⭐ THE BUDGET IS RE-CHECKED UNDER A LOCK, and this is the fix for a live-only defect.
       *
       * ⚠️ **Two concurrent routers both assigned, and the agent ended up holding 7 of 6.** The capacity
       * test lived entirely in the POOL — computed before this transaction opened — so two requests read
       * the same load of 5, both passed, and both wrote. Serialising the *cursor* (which this transaction
       * already did, and which its header claims prevents exactly this) makes the rotation fair; it does
       * nothing about the budget, because the load was decided outside.
       *
       * A `SELECT … count(*) < capacity` in the predicate would not fix it either: under READ COMMITTED
       * both statements see the same snapshot and both succeed. The serialisation has to be explicit.
       *
       * ⓘ The lock is keyed on `(account, operator)` and released with the transaction. Two claims for the
       * same person queue behind each other for the microseconds this takes; claims for different people
       * never touch. The loser gets `{ operatorId: null }` — the "somebody took the slot" answer both the
       * router and the drain already handle by queueing or skipping.
       */
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        `${accountId}:${operatorId}`,
      );

      const chosen = candidates.find((c) => c.operatorId === operatorId);
      const held = await tx.conversation.findMany({
        where: { assignee_operator_id: operatorId, status: { in: openStatuses } },
        select: { channel: true },
      });
      // The SAME arithmetic the pool used, on a load re-read inside the lock. `'exclusive'` means the
      // person is holding work that owns them entirely, which is full whatever the number says.
      const used = unitsUsed(held);
      if (!chosen || used === 'exclusive' || used >= chosen.capacity) return { operatorId: null };

      const before = await tx.conversation.findFirst({
        where: { id: conversationId },
        select: TRANSITION_BEFORE_SELECT,
      });

      /**
       * ⚠️ A conversation that was UNOWNED is claimed conditionally, so two routers cannot both claim it.
       * `count === 0` means somebody else got there first — the same "lost the race" answer as above.
       *
       * ⓘ When it already had an owner this is a deliberate re-route by a caller who asked for one, and the
       * write stays unconditional: adding the guard there would turn a reassignment into a silent refusal.
       */
      const claim = await tx.conversation.updateMany({
        where: {
          id: conversationId,
          ...(before && before.assignee_operator_id === null ? { assignee_operator_id: null } : {}),
        },
        data: {
          assignee_operator_id: operatorId,
          // Feature 024: which desk took it. Written in the SAME statement as the assignee, so the
          // two can never disagree — a conversation assigned by a group's rotation but not marked as
          // that group's work would make the automation scope and the by-desk list quietly wrong.
          ...(routedGroupId ? { routed_group_id: routedGroupId } : {}),
        },
      });
      if (claim.count === 0) return { operatorId: null };

      // Feature 023 — the FIFTH writer of this column, and the one no manual inventory found: the
      // structural guard did. Auto-assignment is precisely the change analytics asks about, so a
      // stream missing it would answer "how much does routing actually move?" wrongly rather than
      // refuse to answer. The actor is the router itself, because "the system" is not an answer.
      if (before) {
        await this.transitions.record(
          tx,
          assigned(accountId, before, operatorId, systemActor('auto-assign'), new Date()),
        );
      }

      if (existing) {
        await tx.roundRobinState.updateMany({
          where: { id: existing.id },
          data: { last_operator_id: nextOperatorId },
        });
      } else {
        await tx.roundRobinState.create({
          data: { account_id: accountId, group_key: groupKey, last_operator_id: nextOperatorId },
        });
      }
      return { operatorId };
    });
  }
}
