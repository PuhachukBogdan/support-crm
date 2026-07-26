import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ConversationRepository } from '../conversation/conversation.repository';
import type { ConversationDetailRow } from '../shared/wire';

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
  ): Promise<ConversationDetailRow | null> {
    const res = await this.prisma.forAccount(accountId).conversation.updateMany({
      where: { id: conversationId },
      data: { assignee_operator_id: operatorId },
    });
    if (res.count === 0) return null;
    return this.conversations.getById(accountId, conversationId);
  }
}
