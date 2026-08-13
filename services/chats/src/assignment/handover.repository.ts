import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { NOT_SHELVED } from '../conversation/shelf';
import { TransitionRecorder } from '../transition/transition.recorder';
import {
  assigned,
  TRANSITION_BEFORE_SELECT,
  type ConversationBefore,
  type TransitionActor,
} from '../transition/conversation-transitions';

/**
 * Giving a departed colleague's work back (W31 / feature 038 — ADR 0043 §4, SEC-PV2).
 *
 * ── ⭐ WHY BOTH HALVES, IN ONE TRANSACTION (research D6) ─────────────────────────────────────────
 * Unassigning is not returning. `AssignConversation('')` nulls the assignee and nothing more, and the
 * drain only ever looks at rows carrying `backlog_at` — so a handover that did only the first half
 * would produce a ticket that is **nobody's AND invisible**, with a green test proving «unassigned».
 * That is exactly the failure SEC-PV2 names: no error, no alert, and a customer writing to nobody.
 *
 * So the two writes are one statement inside one transaction, together with the
 * `conversation.assigned` transition that records who moved it — because a partially applied handover
 * is worse than a refused one, and «the account closed, the work did not move» must be readable
 * rather than inferred.
 *
 * ── ⚠️ THE OPERATOR IS IN THE PREDICATE, not only in the read ───────────────────────────────────
 * Every write here asserts `assignee_operator_id = <the departed operator>`. That is what makes the
 * rpc idempotent (a second run matches nothing) and race-safe (a supervisor who reassigned the ticket
 * between the select and the write keeps their decision — the claim is made by the database, not by
 * this process's memory, the `markUnroutable` rule one file over).
 */

/** One piece of the departed operator's open work, as far as the handover is concerned. */
export interface OpenWorkRow {
  id: string;
  brand_id: string;
  /** The arrival channel KIND — how the channel's default desk is found when no desk was routed. */
  channel: string | null;
  /** The desk the work was routed to, when it was routed at all. The first choice of destination. */
  routed_group_id: string | null;
  /** Its place in line, if it somehow already had one — preserved rather than rewritten (see below). */
  backlog_at: Date | null;
}

const WORK_SELECT = {
  id: true,
  brand_id: true,
  channel: true,
  routed_group_id: true,
  backlog_at: true,
} as const;

/** The transition's before-row, plus the one column the enqueue half has to decide on. */
interface HandoverBefore extends ConversationBefore {
  backlog_at: Date | null;
}

const BEFORE_SELECT = { ...TRANSITION_BEFORE_SELECT, backlog_at: true } as const;

/** Cast on the CLIENT, never on the method — the assignment repository's rule, for its reason. */
interface TransactionScope {
  conversation: {
    findFirst(args: unknown): Promise<HandoverBefore | null>;
    updateMany(args: unknown): Promise<{ count: number }>;
  };
  conversationTransition: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

interface TxCapableClient {
  $transaction<T>(fn: (tx: TransactionScope) => Promise<T>): Promise<T>;
}

@Injectable()
export class HandoverRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransitionRecorder) private readonly transitions: TransitionRecorder,
  ) {}

  /**
   * The batch of open work this call will look at.
   *
   * Shelved conversations are excluded at the front door (`NOT_SHELVED`) rather than filtered later:
   * a suspended or deleted ticket is out of every queue by definition (W27 / 036), and returning one
   * to the backlog would undo a supervisor's decision as a side effect of somebody resigning.
   *
   * Oldest first, `id` as the tie-break — the queue's own ordering idiom, so a capped run takes the
   * work that has waited longest rather than an arbitrary slice.
   */
  async openWorkOf(
    accountId: string,
    operatorId: string,
    statusKeys: readonly string[],
    limit: number,
  ): Promise<OpenWorkRow[]> {
    return (await this.prisma.forAccount(accountId).conversation.findMany({
      where: { assignee_operator_id: operatorId, status: { in: [...statusKeys] }, ...NOT_SHELVED },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: limit,
      select: WORK_SELECT,
    })) as OpenWorkRow[];
  }

  /** How much open work this operator holds in total — the cap's remainder is computed from it. */
  async countOpenWorkOf(
    accountId: string,
    operatorId: string,
    statusKeys: readonly string[],
  ): Promise<number> {
    return this.prisma.forAccount(accountId).conversation.count({
      where: { assignee_operator_id: operatorId, status: { in: [...statusKeys] }, ...NOT_SHELVED },
    });
  }

  /**
   * How much of their work is on the shelf.
   *
   * Counted rather than ignored: the answer «we moved 4 and left 2 alone deliberately» is actionable,
   * where a silent difference between what an administrator can see on the person's card and what the
   * handover reports reads as work gone missing.
   */
  async countShelvedWorkOf(
    accountId: string,
    operatorId: string,
    statusKeys: readonly string[],
  ): Promise<number> {
    return this.prisma.forAccount(accountId).conversation.count({
      where: {
        assignee_operator_id: operatorId,
        status: { in: [...statusKeys] },
        shelved_state: { not: null },
      },
    });
  }

  /**
   * One conversation, both halves, one transaction. `false` = it was no longer this operator's when
   * the write ran (already handed over, or reassigned by a human in between) — not an error, and not
   * a move either.
   */
  async returnToBacklog(
    accountId: string,
    conversationId: string,
    operatorId: string,
    deskId: string,
    at: Date,
    actor: TransitionActor,
  ): Promise<boolean> {
    const db = this.prisma.forAccount(accountId) as unknown as TxCapableClient;

    // Called as a METHOD so `this` stays the Prisma client (feature 013's own lesson).
    return db.$transaction(async (tx) => {
      const before = await tx.conversation.findFirst({
        where: { id: conversationId, assignee_operator_id: operatorId },
        select: BEFORE_SELECT,
      });
      if (!before) return false;

      const res = await tx.conversation.updateMany({
        where: { id: conversationId, assignee_operator_id: operatorId },
        data: {
          assignee_operator_id: null,
          /**
           * ⚠️ An existing stamp WINS, exactly as `BacklogRepository.enqueue` decides it: rewriting
           * `backlog_at` would send the ticket to the back of a queue it was already standing in,
           * demoting it for the crime of its owner leaving.
           */
          backlog_at: before.backlog_at ?? at,
          /**
           * The destination the caller resolved. Written even when `routed_group_id` already held it:
           * one statement is cheaper than a branch, and the value is the same by construction.
           */
          routed_group_id: deskId,
          /**
           * A fresh entry into the queue must not inherit an old «nobody can take this» stamp — the
           * drain writes that alarm once per condition, so a stale stamp would swallow the first real
           * one.
           */
          unroutable_since: null,
        },
      });
      if (res.count === 0) return false;

      await this.transitions.record(tx, assigned(accountId, before, null, actor, at));
      return true;
    });
  }
}
