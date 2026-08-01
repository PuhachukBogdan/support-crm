import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ConversationRepository } from '../conversation/conversation.repository';
import type { ConversationDetailRow } from '../shared/wire';
import type { Metadata } from '@grpc/grpc-js';
import { TransitionRecorder } from '../transition/transition.recorder';
import {
  assigned,
  TRANSITION_BEFORE_SELECT,
  type ConversationBefore,
  type TransitionActor,
} from '../transition/conversation-transitions';

/** Cast on the CLIENT, never on the method — see conversation.repository.ts. */
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

/**
 * Assignment write path (feature 013, US1 — roadmap 4.4). Sets or clears
 * `Conversation.assignee_operator_id` through the account-scoped, fail-closed client
 * (`forAccount`, feature 007 / Principle I).
 *
 * The operator id is a **soft ref**: the operator record lives in users_db and is resolved via the
 * Users contract, never joined (Principle VIII). Existence validation is deliberately deferred to
 * Phase 5 (research R8) — an out-of-account id can never resolve anyway, because resolution is
 * itself account-scoped. So this module makes NO cross-service call.
 *
 * `updateMany` (not `update`) so the injected `account_id` predicate composes: a row outside the
 * account matches nothing and the call reports `null` instead of mutating or leaking.
 *
 * Explicit @Inject: the runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class AssignmentRepository {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TransitionRecorder) private readonly transitions: TransitionRecorder,
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
  ) {}

  /**
   * Assign (`operatorId`), reassign (a different `operatorId`) or unassign (`null`).
   * Returns the updated row, or `null` when the id is not in this account.
   */
  async setAssignee(
    accountId: string,
    conversationId: string,
    operatorId: string | null,
    actor: TransitionActor,
    metadata?: Metadata,
  ): Promise<ConversationDetailRow | null> {
    const db = this.prisma.forAccount(accountId) as unknown as TxCapableClient;

    // Called as a METHOD so `this` stays the Prisma client (feature 013's own lesson, in the module
    // that feature 013 wrote).
    const changed = await db.$transaction(async (tx) => {
      const before = await tx.conversation.findFirst({
        where: { id: conversationId },
        select: TRANSITION_BEFORE_SELECT,
      });
      if (!before) return false;

      const res = await tx.conversation.updateMany({
        where: { id: conversationId },
        data: { assignee_operator_id: operatorId },
      });
      if (res.count === 0) return false;

      // Feature 023: ONE transition type covers assign / reassign / unassign — `from` and `to` are
      // both nullable, so the three are readings of one fact rather than three vocabularies that can
      // drift apart.
      await this.transitions.record(
        tx,
        assigned(accountId, before, operatorId, actor, new Date(), metadata),
      );
      return true;
    });

    if (!changed) return null;
    return this.conversations.getById(accountId, conversationId);
  }
}
