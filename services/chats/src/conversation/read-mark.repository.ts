import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * "This operator OPENED this conversation" — the fact under the agent rail (roadmap 4.19, block W5).
 *
 * The rail itself is a VIEW, not a table: `assignee_operator_id = me` ∧ a row here ∧ a non-terminal
 * status category (see the schema comment on `ConversationReadMark`). This repository owns the two
 * writes-that-are-one and the EXISTS predicate the list filter uses — nothing else, deliberately:
 * there is no delete method, because nothing ever leaves the rail by deletion. Reassignment and
 * resolution remove a conversation from the rail by predicate, and the fact "he read it once" stays
 * true for ever, which is exactly what 9.12's unread arithmetic will need it to be.
 */
@Injectable()
export class ReadMarkRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Record one read. Idempotent by the unique constraint, not by bookkeeping: `first_opened_at` is
   * written once and never touched again; `last_read_at` advances on every call.
   *
   * ⚠️ `operatorId` must come from the CALLER's resolved identity, never from a request field — an
   * agent must not be able to stamp "opened" as somebody else. The one call site does exactly that.
   */
  async recordRead(accountId: string, conversationId: string, operatorId: string): Promise<void> {
    await this.prisma.forAccount(accountId).conversationReadMark.upsert({
      where: {
        account_id_conversation_id_operator_id: {
          account_id: accountId,
          conversation_id: conversationId,
          operator_id: operatorId,
        },
      },
      // account_id is also injected by the scoped client (feature 007); set explicitly to the same
      // value so the static create type is satisfied (the extension applies it last).
      create: { account_id: accountId, conversation_id: conversationId, operator_id: operatorId },
      update: { last_read_at: new Date() },
    });
  }
}
