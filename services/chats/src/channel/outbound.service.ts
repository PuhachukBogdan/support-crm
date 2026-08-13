import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  canSend,
  MAIL_TRANSPORT,
  MailSendError,
  type MailErrorClass,
  type MailTransport,
} from '@crm/common';
import { CHANNEL_CONFIG, type ChannelConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { ChannelParticipantClient } from './participant.client';
import { OutboundRepository, type ClaimedDelivery } from './outbound.repository';

/**
 * Sending an agent's reply out (feature 033, roadmap 6.5 — T065…T068, FR-036…FR-044).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **THE ONE THING THIS FILE MUST NOT DO IS SEND TWICE.** A duplicate reply cannot be recalled, and to
 * the customer it says nobody is reading their ticket. Two independent mechanisms stand behind that, both
 * in `outbound.repository.ts`: the unique constraint on `message_id`, and the conditional claim.
 *
 * ── The order of the four steps, and why each precedes the next ────────────────────────────────
 *  1. **Capability gate** (`canSend`) — refuse a kind that cannot carry a message BEFORE anything else,
 *     so a messenger reply costs no envelope fetch and no connection (FR-006/FR-066).
 *  2. **Message-ID first, stored on the MESSAGE** — before the send, and therefore before the outbox row
 *     is deleted. A customer's reply quotes it weeks later; if it were written after a successful send it
 *     would be lost by any crash in between, and threading cannot be reconstructed afterwards (FR-030).
 *     A retry REUSES the stored id, so a duplicate attempt cannot mint a second identity for one reply.
 *  3. **The envelope, fetched at send time** from `users` — chats holds the handle and never an address
 *     (FR-021b). Fetched here rather than stored on the queue row so there is no window in which a
 *     customer's address sits in `chats_db`.
 *  4. **Send, then delete the row.** In that order: a row deleted first would lose a reply on any failure.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── What is logged, and the one place this deliberately diverges from feature 028 ───────────────
 * The conversation id, an error CLASS, and counts. **Never the recipient**, never the subject, never the
 * body. 028 logs `to=<address>` and defends it correctly — that address is an operator's own. Here it is
 * a customer's, which is precisely what anti-pitching protects (research R6, FR-044).
 */

/** Failures worth trying again. The rest will not change their mind — 028's set, plus the host guard. */
const RETRYABLE: ReadonlySet<string> = new Set<MailErrorClass>(['unreachable', 'auth_failed']);

/** What one pass did. Counts only — the shape every maintenance answer in the product has. */
export interface SendDueResult {
  attempted: number;
  sent: number;
  failed: number;
}

interface MessageRow {
  id: string;
  body: string;
  external_id: string | null;
  created_at: Date;
}

interface ConversationRow {
  id: string;
  brand_id: string;
  channel: string | null;
  subject: string | null;
  channel_participant_id: string | null;
  last_inbound_at: Date | null;
}

@Injectable()
export class OutboundService {
  private readonly logger = new Logger(OutboundService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OutboundRepository) private readonly outbox: OutboundRepository,
    @Inject(ChannelParticipantClient) private readonly participants: ChannelParticipantClient,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    @Inject(CHANNEL_CONFIG) private readonly cfg: ChannelConfig,
  ) {}

  /**
   * Claim and send up to `batch` due deliveries.
   *
   * Driven by the worker's tick, which fires once across replicas — the reason a tick exists at all
   * rather than a `setInterval` in this service (features 017 and 028 both recorded it).
   */
  async sendDue(batch: number, now = new Date()): Promise<SendDueResult> {
    const reclaimed = await this.outbox.reclaimStale(now);
    if (reclaimed > 0) {
      // ⭐ Worth a line: a reclaim means a sender died mid-flight, which is the one window where
      // at-most-once genuinely cannot be guaranteed (see `reclaimStale`). Silence here is healthy.
      this.logger.warn(`outbound reclaimed ${reclaimed} stale claim(s) — a sender died mid-send`);
    }

    let attempted = 0;
    let sent = 0;
    let failed = 0;

    for (let i = 0; i < batch; i += 1) {
      const claimed = await this.outbox.claimNext(now);
      if (!claimed) break;
      attempted += 1;
      if (await this.deliver(claimed, now)) sent += 1;
      else failed += 1;
    }

    if (attempted > 0) {
      this.logger.log(`outbound: attempted=${attempted} sent=${sent} failed=${failed}`);
    }
    return { attempted, sent, failed };
  }

  /**
   * Deliver one claimed row.
   *
   * ⚠️ **Never throws.** A failure is a row: the caller is a tick with nowhere to put an exception, and an
   * escaping error would abandon the rest of the batch — which is feature 031's defect, one level up.
   *
   * @returns true when a transport ACCEPTED the message.
   */
  private async deliver(row: ClaimedDelivery, now: Date): Promise<boolean> {
    const accountId = await this.accountOf(row.id);
    if (!accountId) {
      // The row vanished between claim and read. Nothing to do and nothing to record.
      return false;
    }

    const db = this.prisma.forAccount(accountId);

    const message = (await db.message.findFirst({
      where: { id: row.message_id },
      select: { id: true, body: true, external_id: true, created_at: true },
    })) as MessageRow | null;
    const conversation = (await db.conversation.findFirst({
      where: { id: row.conversation_id },
      select: {
        id: true,
        brand_id: true,
        channel: true,
        subject: true,
        channel_participant_id: true,
        last_inbound_at: true,
      },
    })) as ConversationRow | null;

    if (!message || !conversation) {
      // The message or the ticket is gone. Not retryable, and not an error worth waking anybody: there is
      // nothing left to deliver. Dead-lettered so the row does not circle for ever.
      await this.fail(accountId, row, 'refused', false, now);
      return false;
    }

    // ── 1. The capability gate, first ─────────────────────────────────────────────────────────────
    //
    // ⚠️ Server-side, and deliberately not only where an interface hides a button (FR-043/FR-006). The
    // verdict is the same function any future UI will ask, so the answer cannot drift between them.
    const verdict = canSend(conversation.channel, {
      initiating: false,
      hoursSinceLastInbound: hoursBetween(conversation.last_inbound_at, message.created_at),
    });
    if (!verdict.allowed) {
      this.logger.warn(
        `outbound refused conversation=${conversation.id} reason=${verdict.reason} — nothing sent`,
      );
      await this.fail(accountId, row, verdict.reason, false, now);
      return false;
    }

    if (!conversation.channel_participant_id) {
      // No handle ⇒ no address to answer. It happens for a ticket created before the channel existed, or
      // one an agent opened by hand. Dead-lettered rather than retried: nothing about it will change.
      await this.fail(accountId, row, 'recipient_blocked', false, now);
      return false;
    }

    // ── 2. Our own Message-ID, stored on the MESSAGE before the send ─────────────────────────────
    //
    // Reused when it already exists, so a retried attempt keeps one identity for one reply. Written here
    // rather than after a successful send: the outbox row is deleted on success, and a crash between the
    // send and the write would leave a reply the customer can answer and we cannot thread.
    const messageId = message.external_id ?? mailMessageId(conversation.brand_id);
    if (!message.external_id) {
      await db.message.updateMany({ where: { id: message.id }, data: { external_id: messageId } });
    }

    // ── 3. The envelope, fetched now and never stored here ───────────────────────────────────────
    let to: string;
    try {
      to = await this.participants.envelope(accountId, conversation.channel_participant_id);
    } catch {
      // Unreachable `users`, or a handle it does not know. Retryable: the address exists, we could not ask.
      await this.fail(accountId, row, 'unreachable', row.attempts + 1 < this.cfg.maxAttempts, now);
      return false;
    }

    const inReplyTo = await this.lastInboundExternalId(accountId, conversation.id, message.id);

    // ── 4. Send, then remove the row ─────────────────────────────────────────────────────────────
    try {
      await this.transport.send({
        to,
        // The customer's own subject when they gave one (FR-028), prefixed so their mail client threads it
        // visually as well. No fallback to a derived title here: a reply with no subject is ordinary mail.
        subject: replySubject(conversation.subject),
        text: message.body,
        // The brand's own address, so the reply comes from where the customer wrote (white-label rule 6:
        // never a hardcoded identity). Absent ⇒ the transport's configured sender.
        ...(this.cfg.emailAddress ? { from: this.cfg.emailAddress } : {}),
        headers: {
          'Message-ID': messageId,
          ...(inReplyTo ? { 'In-Reply-To': inReplyTo, References: inReplyTo } : {}),
        },
      });
    } catch (err) {
      const errorClass: string = err instanceof MailSendError ? err.errorClass : 'unreachable';
      const attempts = row.attempts + 1;
      await this.fail(
        accountId,
        row,
        errorClass,
        RETRYABLE.has(errorClass) && attempts < this.cfg.maxAttempts,
        now,
      );
      return false;
    }

    // ⭐ DELETED, not marked sent. This is a queue; the history is the message, which already carries the
    // `Message-ID` a future reply will quote.
    await this.outbox.markSent(accountId, row.id);
    // The conversation and the attempt count. No recipient, no subject, no body (FR-044).
    this.logger.log(`outbound sent conversation=${conversation.id} attempts=${row.attempts + 1}`);
    return true;
  }

  /** Record the failure with a CLASS, and decide whether the clock gets another chance. */
  private async fail(
    accountId: string,
    row: ClaimedDelivery,
    errorClass: string,
    retry: boolean,
    now: Date,
  ): Promise<void> {
    const attempts = row.attempts + 1;
    await this.outbox.markAttemptFailed(accountId, row.id, { attempts, errorClass, retry, now });
    // ⚠️ The class and the count. Never the relay's own sentence — it quotes the envelope, and the
    // envelope is the customer (FR-040).
    this.logger.warn(
      `outbound ${retry ? 'retrying' : 'failed'} conversation=${row.conversation_id} ` +
        `class=${errorClass} attempts=${attempts}`,
    );
  }

  /**
   * Which account a claimed row belongs to.
   *
   * ⚠️ Read unscoped, and it is the same audited exemption `claimNext` carries: a tick belongs to no
   * account, and this read is what establishes the one every subsequent write is scoped to. It returns an
   * account id and nothing else.
   */
  private async accountOf(id: string): Promise<string | null> {
    const row = (await this.prisma.outboundMessage.findFirst({
      where: { id },
      select: { account_id: true },
    })) as { account_id: string } | null;
    return row?.account_id ?? null;
  }

  /**
   * The identifier of the customer's most recent inbound message on this thread — what our reply quotes.
   *
   * Without it the customer's mail client starts a fresh visual thread, and OUR next inbound match has
   * nothing to hang on. Its absence is ordinary, though: an agent may reply to a ticket that arrived by
   * another channel, and then there is nothing to quote.
   */
  private async lastInboundExternalId(
    accountId: string,
    conversationId: string,
    excludeMessageId: string,
  ): Promise<string | null> {
    const row = (await this.prisma.forAccount(accountId).message.findFirst({
      where: {
        conversation_id: conversationId,
        author_type: 'player',
        id: { not: excludeMessageId },
        external_id: { not: null },
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: { external_id: true },
    })) as { external_id: string | null } | null;
    return row?.external_id ?? null;
  }
}

/**
 * A globally unique `Message-ID` in the RFC 5322 shape.
 *
 * ⚠️ The right-hand side is the BRAND id, not a hostname and not a customer's domain. It only has to be
 * unique and stable; putting our relay's hostname there would leak infrastructure into every reply, and
 * putting anything of the customer's there would put their data in a header we generate.
 */
function mailMessageId(brandId: string): string {
  return `<${randomUUID()}@${brandId}.crm>`;
}

/** `Re: ` once, never twice — a mail client shows `Re: Re: Re:` as the thread having gone wrong. */
function replySubject(subject: string | null): string {
  const base = (subject ?? '').trim();
  if (base === '') return 'Re:';
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

/** Whole hours between two instants, or `undefined` when the first is absent (see `canSend`). */
function hoursBetween(from: Date | null, to: Date): number | undefined {
  if (!from) return undefined;
  return Math.floor((to.getTime() - from.getTime()) / 3_600_000);
}
