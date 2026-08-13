import { Inject, Injectable, Logger } from '@nestjs/common';
import { isStatusCategory, type StatusCategory } from '@crm/common';
import { AuditRepository } from '../audit/audit.repository';
import { CHANNEL_CONFIG, type ChannelConfig } from '../config';
import { ConversationRepository } from '../conversation/conversation.repository';
import { MessageRepository } from '../message/message.repository';
import { StatusRepository } from '../status/status.repository';
import { newCorrelationId } from '../transition/conversation-transitions';
import { ApiChannelAdapter } from './adapters/api.adapter';
import type { NormalisedInbound } from './adapters/adapter.contract';
import { ChannelRepository, type ChannelRow } from './channel.repository';
import { IntakeLedger, type IntakeRefusal } from './intake.ledger';
import { ChannelParticipantClient, type ResolvedParticipant } from './participant.client';
import { decideThreadOutcome, type ThreadDecision } from './reopen';
import { verifySignature } from './signature';
import { ThreadResolver } from './threading';

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
    // ── US2 (roadmap 6.4) — the three collaborators the mail path adds ────────────────────────────
    @Inject(ThreadResolver) private readonly threads: ThreadResolver,
    @Inject(ChannelParticipantClient) private readonly participants: ChannelParticipantClient,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
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
    // 4. The status, from the ACCOUNT'S OWN catalogue (FR-016).
    //
    // ⚠️ A misconfigured account is refused LOUDLY rather than given the literal `'new'`. That word is a
    // seeded default, not a guarantee — a supervisor may have retired it — and writing a key the
    // catalogue cannot resolve is the drift feature 032 removed. The composite foreign key would refuse
    // it anyway, on a customer's conversation, at a moment nobody is watching.
    //
    // ⚠️ **Resolved BEFORE the claim, and the order is load-bearing.** It used to run after. A claim
    // followed by a refusal leaves a ledger row saying *accepted* with no ticket behind it — and every
    // retry from then on is answered "duplicate", so the customer's message is lost while the provider
    // is satisfied and nothing is red. Every deterministic refusal now happens before the claim; see
    // `IntakeLedger.release` for the non-deterministic remainder.
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

    // 5. ⭐ THE CLAIM. Insert-first; a unique violation means "already accepted". Before any product
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

    return this.writeClaimed(channel, claim.intakeId, async () => {
      // 6. The ticket. Created UNIDENTIFIED: US3 resolves who wrote, and until it does the honest answer
      //    is the one ADR 0044 §1 demands — an explicit state, not a blank read as "not filled yet".
      const conversation = await this.conversations.create(channel.account_id, {
        brandId: channel.brand_id,
        channel: channel.kind,
        status: statusKey,
        identityState: 'unidentified',
      });

      const created = await this.postCustomerMessage(channel, conversation.id, message, null);
      return { conversationId: conversation.id, messageId: created };
    });
  }

  /**
   * ⭐ Accept one message taken out of a brand's mailbox (US2 — roadmap 6.4, FR-027…FR-035).
   *
   * ═════════════════════════════════════════════════════════════════════════════════════════════════
   * The MIME was parsed in the worker (it holds the parser and the connection); what arrives here is
   * already normalised. This method owns the four things that are *ours* rather than the mailbox's:
   * **where the message belongs**, **who wrote**, **what the ticket is called**, and **at-most-once**.
   *
   * ── The ordering, and why every refusal comes before the claim ─────────────────────────────────
   * Resolve → check kind → check content → register the envelope → resolve the thread → resolve the
   * status → **CLAIM** → write. Everything that can say no does so while the message is still sitting
   * unread in the mailbox, so a refusal costs nothing and the next pass tries again. After the claim
   * only writes remain, and a failure among those releases the claim (`IntakeLedger.release`).
   * ═════════════════════════════════════════════════════════════════════════════════════════════════
   */
  async acceptInboundEmail(input: {
    channelKey: string;
    /** The RFC `Message-ID`. The at-most-once key (FR-032) — refused when absent, never generated. */
    messageId: string;
    inReplyTo?: string;
    references?: string[];
    /** ⚠️ Passed straight through to `users` and never stored or logged here (FR-021b/FR-047). */
    fromAddress: string;
    /** The `Subject` header verbatim. Empty means the source gave none — not a title of `''`. */
    subject: string;
    bodyText: string;
    uploadIds: string[];
    sentAt?: number;
  }): Promise<IntakeOutcome> {
    const channel = await this.channels.resolveByKey(input.channelKey);
    if (!channel) {
      this.logger.warn('mail intake refused class=unknown_channel');
      return REFUSED('unknown_channel');
    }

    // The reader is configured with a channel key, and a key naming an `api` channel is a
    // misconfiguration rather than mail on an API channel. Taking it in would stamp `channel = api` on
    // tickets that arrived by email — corrupting the SLA dimension (ADR 0041) and the Inbox filter, in a
    // way no screen would ever show.
    if (channel.kind !== 'email') {
      await this.refuse(channel, input.messageId, 'channel_kind_mismatch');
      return REFUSED('channel_kind_mismatch');
    }

    // No `Message-ID` ⇒ no at-most-once key. Refused rather than accepted with a generated one, for the
    // same reason the API adapter refuses a delivery with no event id: a generated key makes every
    // redelivery look new, and a reconnect redelivers by design (FR-027c).
    const messageId = input.messageId.trim();
    if (!messageId) {
      await this.refuse(channel, '', 'no_event_id');
      return REFUSED('no_event_id');
    }

    // An address we cannot answer is not a ticket we can serve. Note this is stricter than the API
    // channel, which legitimately has no address at all — here the envelope IS the reply path.
    const fromAddress = input.fromAddress.trim();
    if (!fromAddress) {
      await this.refuse(channel, messageId, 'incomplete');
      return REFUSED('incomplete');
    }

    // ⚠️ Nothing to show ⇒ refuse. Deliberately weaker than the API adapter's "a body is required":
    // an email whose `Subject` is the whole question is an ordinary support request, and so is one
    // carrying only a screenshot. Only a message with no body, no subject AND no file is empty.
    const subject = input.subject.trim();
    const body = input.bodyText;
    if (body.trim() === '' && subject === '' && input.uploadIds.length === 0) {
      await this.refuse(channel, messageId, 'incomplete');
      return REFUSED('incomplete');
    }

    // Where to answer, and who wrote — one call, before the claim. An unreachable `users` refuses the
    // intake and leaves the mail where it is; a `users` that simply found nobody returns an
    // unidentified answer and intake continues (FR-023). See `participant.client.ts`.
    let participant: ResolvedParticipant;
    try {
      participant = await this.participants.resolve({
        accountId: channel.account_id,
        brandId: channel.brand_id,
        channelKind: channel.kind,
        kind: 'email',
        value: fromAddress,
      });
    } catch {
      await this.refuse(channel, messageId, 'identity_unavailable');
      // The class, the channel and the account. Never the address, never the target host.
      this.logger.error(
        `mail intake refused class=identity_unavailable account=${channel.account_id} — the message stays in the mailbox`,
      );
      return REFUSED('identity_unavailable');
    }

    // Which ticket this belongs to — matched only on identifiers we ourselves stored (`threading.ts`).
    const match = await this.threads.resolve(channel.account_id, channel.brand_id, {
      inReplyTo: input.inReplyTo,
      references: input.references,
    });
    const decision = decideThreadOutcome(
      match,
      match ? await this.categoryOfStatus(channel.account_id, match.status) : null,
    );

    // The status this decision needs, from the account's own catalogue — `open` for a reopen, `new` for
    // a ticket that is about to exist, none at all for an append.
    const needed: StatusCategory | null =
      decision.kind === 'reopen' ? 'open' : decision.kind === 'append' ? null : 'new';
    let statusKey: string | null = null;
    if (needed) {
      statusKey = await this.statuses.defaultKeyOfCategory(channel.account_id, needed);
      if (!statusKey) {
        await this.refuse(channel, messageId, 'no_status_configured');
        this.logger.error(
          `mail intake refused class=no_status_configured account=${channel.account_id} category=${needed}`,
        );
        return REFUSED('no_status_configured');
      }
    }

    const claim = await this.ledger.claim({
      accountId: channel.account_id,
      channelId: channel.id,
      externalEventId: messageId,
    });
    if (!claim.fresh) {
      // A reconnect re-reading its batch, or the sweep meeting a message the reader already took. Both
      // are NORMAL (FR-027c) and both answer with what the first acceptance produced.
      return {
        conversationId: claim.conversationId ?? '',
        messageId: claim.messageId ?? '',
        duplicate: true,
      };
    }

    const normalised: NormalisedInbound = {
      externalEventId: messageId,
      externalMessageId: messageId,
      body,
      subject: subject === '' ? undefined : subject,
      identity: { kind: 'email', value: fromAddress },
      attachments: [],
    };

    return this.writeClaimed(channel, claim.intakeId, () =>
      this.applyThreadDecision(channel, decision, {
        message: normalised,
        statusKey,
        participant,
        uploadIds: input.uploadIds,
      }),
    );
  }

  /**
   * Carry out one thread decision. The four arms write different rows and one message.
   *
   * ⚠️ The message is posted in **every** arm, and posted LAST in none of them by accident: a reopen that
   * changed the status and then failed to write the message would show an agent a ticket that came back
   * for no visible reason. The whole method runs under {@link writeClaimed}, so a failure anywhere gives
   * the claim back and the next pass repeats it.
   */
  private async applyThreadDecision(
    channel: ChannelRow,
    decision: ThreadDecision,
    ctx: {
      message: NormalisedInbound;
      statusKey: string | null;
      participant: ResolvedParticipant;
      uploadIds: string[];
    },
  ): Promise<{ conversationId: string; messageId: string }> {
    const { message, participant, uploadIds } = ctx;
    const playerId = participant.playerId || null;

    if (decision.kind === 'append' || decision.kind === 'reopen') {
      const conversationId = decision.conversationId;

      // ⓘ **The conversation's envelope handle is NOT re-pointed at this message's sender**, and that is a
      // decision rather than an omission. A reply that threaded into this ticket is by definition part of
      // the thread its participant started, so the address the ticket already answers to is one the
      // customer themselves used. FR-021b's harm is answering the *registered* address instead of the one
      // they wrote from — not answering the one they wrote from a week earlier. Re-pointing would also let
      // a forged `In-Reply-To` redirect an existing conversation's replies, which is a worse trade.


      if (decision.kind === 'reopen') {
        // The status change and its transition are one statement inside `setStatus` (feature 023).
        await this.conversations.setStatus(
          channel.account_id,
          conversationId,
          ctx.statusKey as string,
          { kind: 'integration', ref: `channel:${channel.kind}`, correlationId: newCorrelationId() },
        );
        // ⚠️ Audited AS WELL as recorded as a transition, and the catalogue says why: this is a state
        // change **nobody authorised**. A ticket that reopens itself with no accountability record is a
        // closed-work number that changes with nothing to point at.
        await this.audit.append(channel.account_id, {
          action: 'conversation.reopened_by_reply',
          actorUserId: '',
          actorKind: 'system',
          actorRef: `channel:${channel.kind}`,
          targetRef: `conversation:${conversationId}`,
          detail: { channelKind: channel.kind },
        });
      }

      const messageId = await this.postCustomerMessage(
        channel,
        conversationId,
        message,
        playerId,
        uploadIds,
      );
      return { conversationId, messageId };
    }

    // `new` and `continue` both create a ticket; only the link differs (FR-029b).
    const conversation = await this.conversations.create(channel.account_id, {
      brandId: channel.brand_id,
      channel: channel.kind,
      status: ctx.statusKey as string,
      playerId: playerId ?? undefined,
      // ⚠️ STORED, not derived from an empty player id (FR-024 / ADR 0044 §1). An `ambiguous` match is
      // `unidentified` too: more than one candidate means we must not choose, and "we could not tell"
      // is the same fact to a reader as "nobody matched".
      identityState: playerId ? 'identified' : 'unidentified',
      channelParticipantId: participant.participantId,
      continuesConversationId:
        decision.kind === 'continue' ? decision.continuesConversationId : undefined,
      // FR-028: the source's own title, frozen at creation so no derivation may overwrite it. Absent
      // when the `Subject` was empty, which leaves our window open rather than storing a blank title.
      ...(message.subject ? { subject: message.subject, subjectSource: 'source' as const } : {}),
    });

    const messageId = await this.postCustomerMessage(
      channel,
      conversation.id,
      message,
      playerId,
      uploadIds,
    );
    return { conversationId: conversation.id, messageId };
  }

  /**
   * The customer's words, on either channel.
   *
   * `authorType: 'player'` with a possibly-NULL author id — an unresolved writer is still a customer,
   * and a placeholder id would be exactly the invented identity ADR 0044 §1 forbids.
   *
   * ⚠️ The actor kind is `integration`, which already existed in the transition vocabulary and is
   * precisely this case: an act with no human behind it. A `system` actor would have been a lie of a
   * different kind — a sweep or a job is ours, and this is somebody else's message arriving.
   */
  private async postCustomerMessage(
    channel: ChannelRow,
    conversationId: string,
    message: NormalisedInbound,
    playerId: string | null,
    uploadIds: string[] = [],
  ): Promise<string> {
    const created = await this.messages.post(
      channel.account_id,
      {
        conversationId,
        authorType: 'player',
        authorId: playerId,
        body: message.body,
        isPrivate: false,
        mentions: [],
        uploadIds,
        // The identifier a future reply will quote (FR-030). NULL on the API channel, which has none.
        externalId: message.externalMessageId ?? null,
      },
      { kind: 'integration', ref: `channel:${channel.kind}`, correlationId: newCorrelationId() },
    );
    return created.id;
  }

  /**
   * Run the post-claim writes, stamp what they produced, and **give the claim back if they throw**.
   *
   * Without the release, a database that blinked between the claim and the write would leave a ledger row
   * saying *accepted* with no ticket behind it — and every retry answered "duplicate" for ever. See
   * `IntakeLedger.release`; this is its only caller and there should never be a second one.
   */
  private async writeClaimed(
    channel: ChannelRow,
    intakeId: string,
    write: () => Promise<{ conversationId: string; messageId: string }>,
  ): Promise<IntakeOutcome> {
    let produced: { conversationId: string; messageId: string };
    try {
      produced = await write();
    } catch (err) {
      await this.ledger.release(channel.account_id, intakeId);
      throw err;
    }

    await this.ledger.stampProduced(channel.account_id, intakeId, produced);

    // The channel KIND and ids. No body, no address, no subject line (Principle IV).
    this.logger.log(
      `intake accepted kind=${channel.kind} account=${channel.account_id} conversation=${produced.conversationId}`,
    );
    return { ...produced, duplicate: false };
  }

  /** Record a refusal against a resolved channel. One line, so no call site can forget a field. */
  private async refuse(
    channel: ChannelRow,
    externalEventId: string,
    refusal: IntakeRefusal,
  ): Promise<void> {
    await this.ledger.recordRefusal({
      accountId: channel.account_id,
      channelId: channel.id,
      externalEventId,
      refusal,
    });
  }

  /**
   * The CATEGORY of a stored status key, or `null` when the catalogue cannot resolve it.
   *
   * ⚠️ `null` is not "no category" — it is *we cannot tell*, and `decideThreadOutcome` treats it as the
   * conservative case rather than guessing. A retired status is still resolvable (`resolveActive` reads
   * active rows only, so a retired one lands here as null) which is the right reading: a ticket wearing
   * a retired status has no category anything may branch on.
   */
  private async categoryOfStatus(
    accountId: string,
    statusKey: string,
  ): Promise<StatusCategory | null> {
    const row = await this.statuses.resolveActive(accountId, statusKey);
    if (!row) return null;
    return isStatusCategory(row.category) ? row.category : null;
  }
}
