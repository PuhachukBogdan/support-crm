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
    findFirst(args: unknown): Promise<{ id: string; cursor: number } | null>;
    updateMany(args: unknown): Promise<unknown>;
    create(args: unknown): Promise<unknown>;
  };
  conversation: {
    // Feature 023: the transition needs the row as it was BEFORE the assignment, read inside the
    // same transaction so `from` is the value this write actually replaced.
    findFirst(args: unknown): Promise<ConversationBefore | null>;
    updateMany(args: unknown): Promise<unknown>;
  };
  conversationTransition: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
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
  ) {}

  /** The stored cursor for a group, or -1 when the rotation has never run. */
  async readCursor(accountId: string, groupKey: string): Promise<number> {
    const row = (await this.prisma.forAccount(accountId).roundRobinState.findFirst({
      where: { group_key: groupKey },
      select: { cursor: true },
    })) as { cursor: number } | null;
    return row ? row.cursor : -1;
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

    // Called as a method so `this` stays the Prisma client (see TxCapableClient).
    return db.$transaction(async (tx) => {
      const existing = await tx.roundRobinState.findFirst({
        where: { group_key: groupKey },
        select: { id: true, cursor: true },
      });

      const { operatorId, nextCursor } = selectRoundRobin(candidates, existing?.cursor ?? -1);
      if (operatorId === null) return { operatorId: null };

      const before = await tx.conversation.findFirst({
        where: { id: conversationId },
        select: TRANSITION_BEFORE_SELECT,
      });

      await tx.conversation.updateMany({
        where: { id: conversationId },
        data: {
          assignee_operator_id: operatorId,
          // Feature 024: which desk took it. Written in the SAME statement as the assignee, so the
          // two can never disagree — a conversation assigned by a group's rotation but not marked as
          // that group's work would make the automation scope and the by-desk list quietly wrong.
          ...(routedGroupId ? { routed_group_id: routedGroupId } : {}),
        },
      });

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
          data: { cursor: nextCursor },
        });
      } else {
        await tx.roundRobinState.create({
          data: { account_id: accountId, group_key: groupKey, cursor: nextCursor },
        });
      }
      return { operatorId };
    });
  }
}
