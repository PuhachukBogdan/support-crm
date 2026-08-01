import { Inject, Injectable } from '@nestjs/common';
import { ConversationRepository } from '../conversation/conversation.repository';
import { AutomationsRepository } from '../automation/automations.repository';
import { DomainEventDispatcher } from './events.dispatcher';
import {
  conversationCreatedKey,
  firstReplyBreachedKey,
  messageReceivedKey,
  statusChangedKey,
  type AutomationTrigger,
  type ConversationFacts,
} from './events.types';

/**
 * The controller-side publish helper (feature 014, research R4).
 *
 * Controllers call this **after** a successful write; it gathers the condition inputs and publishes.
 * It exists so three controllers do not each hand-roll fact collection, and it is deliberately NOT a
 * repository: repositories cannot publish, which is what makes a cascade impossible (FR-006). The
 * structural guard (`no-publish-from-repositories.spec.ts`) allow-lists this file by name for exactly
 * that reason — it is the publish path, not a data-access path.
 *
 * Publishing is best-effort with respect to the caller: `DomainEventDispatcher` swallows a failing
 * subscriber, so a broken rule can never fail the human action that triggered it.
 */
@Injectable()
export class DomainEventPublisher {
  constructor(
    @Inject(DomainEventDispatcher) private readonly dispatcher: DomainEventDispatcher,
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
    @Inject(AutomationsRepository) private readonly automations: AutomationsRepository,
  ) {}

  /** A conversation was created. */
  async conversationCreated(accountId: string, conversationId: string): Promise<number> {
    return this.emit(
      'AUTOMATION_TRIGGER_CONVERSATION_CREATED',
      accountId,
      conversationId,
      conversationCreatedKey(conversationId),
    );
  }

  /** An inbound PLAYER message arrived. `messageText` is matched in memory only, never stored. */
  async messageReceived(
    accountId: string,
    conversationId: string,
    messageId: string,
    body: string,
  ): Promise<number> {
    return this.emit(
      'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
      accountId,
      conversationId,
      messageReceivedKey(messageId),
      body,
    );
  }

  /** A conversation's status changed. */
  async statusChanged(
    accountId: string,
    conversationId: string,
    newStatus: string,
    updatedAt: Date,
  ): Promise<number> {
    return this.emit(
      'AUTOMATION_TRIGGER_STATUS_CHANGED',
      accountId,
      conversationId,
      statusChangedKey(conversationId, newStatus, updatedAt),
    );
  }

  /** The first-reply target was missed (feature 014, US3 — emitted by the maintenance controller). */
  async firstReplyBreached(accountId: string, conversationId: string): Promise<number> {
    return this.emit(
      'AUTOMATION_TRIGGER_FIRST_REPLY_BREACHED',
      accountId,
      conversationId,
      firstReplyBreachedKey(conversationId),
    );
  }

  private async emit(
    trigger: AutomationTrigger,
    accountId: string,
    conversationId: string,
    eventKey: string,
    messageText?: string,
  ): Promise<number> {
    const facts = await this.facts(accountId, conversationId, messageText);
    if (!facts) return 0; // the conversation vanished — nothing to react to.
    return this.dispatcher.publish({ trigger, accountId, conversationId, eventKey, facts });
  }

  /** Collect the condition inputs. Account-scoped like every other read (Principle I). */
  private async facts(
    accountId: string,
    conversationId: string,
    messageText?: string,
  ): Promise<ConversationFacts | null> {
    const c = await this.conversations.getById(accountId, conversationId);
    if (!c) return null;
    const labelIds = await this.automations.labelIdsFor(accountId, conversationId);
    return {
      status: c.status,
      priority: c.priority,
      brandId: c.brand_id,
      channel: c.channel,
      hasAssignee: !!c.assignee_operator_id,
      labelIds,
      // Feature 024: the group SCOPE input. Null when the work was not routed through a desk.
      routedGroupId: c.routed_group_id,
      ...(messageText === undefined ? {} : { messageText }),
    };
  }
}
