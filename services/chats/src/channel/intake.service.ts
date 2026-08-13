import { Inject, Injectable, Logger } from '@nestjs/common';
import { CHANNEL_CONFIG, type ChannelConfig } from '../config';
import { ConversationRepository } from '../conversation/conversation.repository';
import { MessageRepository } from '../message/message.repository';
import { StatusRepository } from '../status/status.repository';
import { newCorrelationId } from '../transition/conversation-transitions';
import { ApiChannelAdapter } from './adapters/api.adapter';
import type { NormalisedInbound } from './adapters/adapter.contract';
import { ChannelRepository, type ChannelRow } from './channel.repository';
import { IntakeLedger, type IntakeRefusal } from './intake.ledger';
import { verifySignature } from './signature';

export interface IntakeOutcome {
  conversationId: string;
  messageId: string;
  duplicate: boolean;
  refusal?: IntakeRefusal;
}

const REFUSED = (refusal: IntakeRefusal): IntakeOutcome => ({
  conversationId: '',
  messageId: '',
  duplicate: false,
  refusal,
});

/**
 * Channel intake (feature 033, roadmap 6.1 — subpoint 2.1a).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * **This is the first write path in the product that a stranger can reach.** Everything before it was
 * reached by somebody holding a session. Three consequences shape the whole file:
 *
 *  1. **The credential decides the tenant.** The account and brand come from the `Channel` row the key
 *     named — never from the payload (FR-011). A body claiming a brand is data, not authority.
 *  2. **Order matters.** Resolve → verify → normalise → CLAIM → write. Each step is cheaper than the
 *     next and each refuses without touching product data, so a flood of forged deliveries costs a
 *     lookup and an HMAC rather than a transaction.
 *  3. **A refusal leaves nothing behind** (FR-010) except a ledger row, which is the audit of a
 *     rejection and carries no payload.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── Why the write is synchronous rather than enqueued ───────────────────────────────────────────
 * The caller is told "accepted" only once the ticket is durable. A queue in front of the write would make
 * *accepted exactly once* a property of two systems agreeing instead of one constraint in one database —
 * and the provider retries on anything that is not an acknowledgement, so a lost queue message becomes a
 * duplicate ticket rather than a lost one.
 *
 * ── What is NOT here, deliberately ─────────────────────────────────────────────────────────────
 * Identity resolution beyond recording that we have none (US3 fills it), threading (US2), and outbound
 * (US4). The ticket is created `unidentified` and complete, because ADR 0044 §1 is absolute that identity
 * never blocks intake: a message we cannot attribute is still a customer's message.
 */
@Injectable()
export class ChannelIntakeService {
  private readonly logger = new Logger(ChannelIntakeService.name);

  constructor(
    @Inject(CHANNEL_CONFIG) private readonly cfg: ChannelConfig,
    @Inject(ChannelRepository) private readonly channels: ChannelRepository,
    @Inject(IntakeLedger) private readonly ledger: IntakeLedger,
    @Inject(ApiChannelAdapter) private readonly apiAdapter: ApiChannelAdapter,
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
    @Inject(MessageRepository) private readonly messages: MessageRepository,
    @Inject(StatusRepository) private readonly statuses: StatusRepository,
  ) {}

  /**
   * Accept one signed delivery on an API channel.
   *
   * ⚠️ Never throws for a refusal. A refusal is an OUTCOME the caller maps to a status code; throwing
   * would make the gateway's error handler decide what a forged signature means, which is a decision
   * that belongs here.
   */
  async acceptApiDelivery(input: {
    channelKey: string;
    rawBodyText: string;
    signature: string | undefined;
    receivedAt: number;
  }): Promise<IntakeOutcome> {
    // 1. Which channel, and therefore which tenant. A disabled channel is indistinguishable from an
    //    unknown one — see `ChannelRepository.resolveByKey`.
    const channel = await this.channels.resolveByKey(input.channelKey);
    if (!channel) {
      // ⚠️ Nothing is recorded. There is no account to record it against, and inventing one would put a
      // row in some tenant's ledger for a delivery that named no tenant. The absence of a row IS the
      // information here, and the gateway's 404 is what a caller sees.
      this.logger.warn('intake refused class=unknown_channel');
      return REFUSED('unknown_channel');
    }

    // 2. The signature, over exactly the bytes that arrived.
    const verdict = verifySignature({
      header: input.signature,
      rawBody: input.rawBodyText,
      secret: this.cfg.secrets.get(channel.key),
      receivedAt: input.receivedAt,
      replayWindowSeconds: this.cfg.replayWindowSeconds,
    });
    if (!verdict.ok) {
      const refusal: IntakeRefusal = verdict.refusal === 'stale' ? 'replay_window' : 'signature';
      await this.ledger.recordRefusal({
        accountId: channel.account_id,
        channelId: channel.id,
        externalEventId: '',
        refusal,
      });
      return REFUSED(refusal);
    }

    // 3. Their shape → ours. Pure, and the only place that knows their format.
    const normalised = this.apiAdapter.normalise(Buffer.from(input.rawBodyText, 'utf8'));
    if (!normalised.ok) {
      await this.ledger.recordRefusal({
        accountId: channel.account_id,
        channelId: channel.id,
        externalEventId: '',
        refusal: normalised.refusal,
      });
      return REFUSED(normalised.refusal);
    }

    return this.acceptNormalised(channel, normalised.message);
  }

  /**
   * The half both channels share: claim, then write.
   *
   * Separated from the API-specific steps above so US2's mailbox path reaches the same ledger and the
   * same write — two intake paths with two writes is how they end up creating subtly different tickets.
   */
  async acceptNormalised(channel: ChannelRow, message: NormalisedInbound): Promise<IntakeOutcome> {
    // 4. ⭐ THE CLAIM. Insert-first; a unique violation means "already accepted". Before any product
    //    data, so a duplicate costs one failed insert rather than a half-built ticket to unwind.
    const claim = await this.ledger.claim({
      accountId: channel.account_id,
      channelId: channel.id,
      externalEventId: message.externalEventId,
    });
    if (!claim.fresh) {
      return {
        conversationId: claim.conversationId ?? '',
        messageId: claim.messageId ?? '',
        duplicate: true,
      };
    }

    // 5. The status, from the ACCOUNT'S OWN catalogue (FR-016).
    //
    // ⚠️ A misconfigured account is refused LOUDLY rather than given the literal `'new'`. That word is a
    // seeded default, not a guarantee — a supervisor may have retired it — and writing a key the
    // catalogue cannot resolve is the drift feature 032 removed. The composite foreign key would refuse
    // it anyway, on a customer's conversation, at a moment nobody is watching.
    const statusKey = await this.statuses.defaultKeyOfCategory(channel.account_id, 'new');
    if (!statusKey) {
      await this.ledger.recordRefusal({
        accountId: channel.account_id,
        channelId: channel.id,
        externalEventId: message.externalEventId,
        refusal: 'no_status_configured',
      });
      this.logger.error(
        `intake refused class=no_status_configured account=${channel.account_id} — no active status in category 'new'`,
      );
      return REFUSED('no_status_configured');
    }

    // 6. The ticket. Created UNIDENTIFIED: US3 resolves who wrote, and until it does the honest answer is
    //    the one ADR 0044 §1 demands — an explicit state, not a blank somebody reads as "not filled yet".
    const conversation = await this.conversations.create(channel.account_id, {
      brandId: channel.brand_id,
      channel: channel.kind,
      status: statusKey,
      identityState: 'unidentified',
    });

    // 7. The customer's words. `authorType: 'player'` with a NULL author id — we do not know who they
    //    are yet, and a placeholder id would be exactly the invented identity ADR 0044 §1 forbids.
    //
    //    ⚠️ The actor kind is `integration`, which already existed in the transition vocabulary and is
    //    precisely this case: an act with no human behind it. A `system` actor would have been a lie of a
    //    different kind — a sweep or a job is ours, and this is somebody else's message arriving.
    const created = await this.messages.post(
      channel.account_id,
      {
        conversationId: conversation.id,
        authorType: 'player',
        authorId: null,
        body: message.body,
        isPrivate: false,
        mentions: [],
      },
      { kind: 'integration', ref: `channel:${channel.kind}`, correlationId: newCorrelationId() },
    );

    await this.ledger.stampProduced(channel.account_id, claim.intakeId, {
      conversationId: conversation.id,
      messageId: created.id,
    });

    // The channel KIND and counts. No body, no identity, no payload (Principle IV).
    this.logger.log(
      `intake accepted kind=${channel.kind} account=${channel.account_id} conversation=${conversation.id}`,
    );

    return { conversationId: conversation.id, messageId: created.id, duplicate: false };
  }
}
