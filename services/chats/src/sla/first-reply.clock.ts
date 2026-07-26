import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConversationRepository } from '../conversation/conversation.repository';
import { decideStart, decideStop } from './first-reply';
import { resolveTarget } from './policy-resolution';
import { SlaRepository } from './sla.repository';

/**
 * The clock's controller-side driver (feature 014, US2 — roadmap 4.7).
 *
 * Two calls, from the message write edges:
 *   • `onInboundPlayerMessage` — start the measurement if this is the first one and a target applies.
 *   • `onStaffMessage` — stop it, but ONLY for a public reply. A private note is passed through as a
 *     no-op rather than not being called at all, so the "a note changes nothing" rule lives in one
 *     place (`decideStop`) instead of being re-derived at each call site.
 *
 * All decisions come from the pure module; this class only does I/O. Failures are swallowed and logged:
 * the SLA measurement is an observation of the conversation, and a broken observation must never fail
 * the operator's actual message.
 */
@Injectable()
export class FirstReplyClock {
  private readonly logger = new Logger(FirstReplyClock.name);

  constructor(
    @Inject(SlaRepository) private readonly sla: SlaRepository,
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
  ) {}

  /** An inbound player message arrived. Starts the clock when it is the first one. */
  async onInboundPlayerMessage(accountId: string, conversationId: string): Promise<void> {
    try {
      const existing = await this.sla.getState(accountId, conversationId);
      if (existing) return; // never restart — see decideStart
      const conversation = await this.conversations.getById(accountId, conversationId);
      if (!conversation) return;
      const policies = await this.sla.listPolicies(accountId);
      const target = resolveTarget(policies, {
        priority: conversation.priority,
        brandId: conversation.brand_id,
      });
      const intent = decideStart(null, target, new Date());
      if (!intent) return; // no policy ⇒ no clock (absence is not a zero target)
      await this.sla.start(accountId, conversationId, intent);
    } catch (err) {
      this.logger.warn(
        `could not start the first-reply clock for conversation ${conversationId}: ${
          err instanceof Error ? err.name : 'error'
        }`,
      );
    }
  }

  /**
   * A staff message was posted. `isPublicReply=false` (a private note) is deliberately still routed
   * here and resolves to no change (FR-012 / SC-007).
   */
  async onStaffMessage(
    accountId: string,
    conversationId: string,
    isPublicReply: boolean,
  ): Promise<void> {
    try {
      const existing = await this.sla.getState(accountId, conversationId);
      const intent = decideStop(existing, isPublicReply, new Date());
      if (!intent) return;
      await this.sla.stop(accountId, conversationId, intent);
    } catch (err) {
      this.logger.warn(
        `could not stop the first-reply clock for conversation ${conversationId}: ${
          err instanceof Error ? err.name : 'error'
        }`,
      );
    }
  }
}
