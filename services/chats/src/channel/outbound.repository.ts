import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * The conversation outbox (feature 033, roadmap 6.5 — T062, research R6).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **A REPLY SENT TWICE CANNOT BE RECALLED.** That is what separates this file from every other queue
 * in the product: an export run twice is a wasted minute, a sweep run twice is a no-op, and a customer
 * who receives the same answer twice has been shown that nobody is reading their ticket.
 *
 * Exactly-once rests on **two** independent things, and neither is a convention:
 *   1. `@@unique([message_id])` — one message can have at most one intent, so a retried request that
 *      posts the same reply cannot produce a second copy (asserted structurally, FR-050).
 *   2. `pending → sending` as a **conditional update** — two claimers race, the second matches zero
 *      rows. Idempotency comes from the predicate rather than from bookkeeping, which is the mechanism
 *      features 017 and 028 both proved.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── The two deliberate deltas from feature 028's outbox ─────────────────────────────────────────
 *  1. **`next_attempt_at` exists.** 028 sets a failed row back to `pending` and the very next tick tries
 *     again, with no growing gap — acceptable for a login code somebody is waiting for, wrong for a
 *     relay that is down, where retrying every fifteen seconds is a denial of service we perform on
 *     ourselves. The claim predicate is therefore `pending AND next_attempt_at <= now`.
 *  2. **The recipient is not stored and not logged.** 028 stores `to_email` and logs it, correctly,
 *     because that address is an operator's own work address. Here it is a **customer's**, which is
 *     exactly what anti-pitching protects — so there is no recipient column at all
 *     (`tests/channels/constraints-033.spec.ts` asserts its absence) and the envelope is fetched from
 *     `users` at send time.
 *
 * ── Delete on success, and the one consequence designed around it ──────────────────────────────
 * A sent row is DELETED rather than archived: this is a queue, and the history is the message itself.
 * The `Message-ID` we issued must outlive the row, because a customer's reply quotes it weeks later — so
 * it lives on the **Message**, written before the row is removed (`outbound.service.ts`).
 */

/** A row claimed for sending. Only what the sender needs — note the absence of an address. */
export interface ClaimedDelivery {
  id: string;
  conversation_id: string;
  message_id: string;
  channel_id: string;
  attempts: number;
}

/** The subset of a transaction this repository writes through, so `post` can enqueue inside its own. */
export type OutboxTx = {
  outboundMessage: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
};

/** How long a claim may sit before the sweep assumes the claimer died. 028's value, same reasoning. */
const STALE_CLAIM_MS = 120_000;

/** The backoff base. `base * 2^attempts`, so 30 s · 1 m · 2 m · 4 m · 8 m within a five-attempt budget. */
const BACKOFF_BASE_MS = 30_000;

/** Bounded, so an old row does not schedule itself past the point anybody is still watching. */
const BACKOFF_MAX_MS = 30 * 60_000;

@Injectable()
export class OutboundRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Record the intent to deliver one message.
   *
   * ⚠️ **Call this inside the transaction that writes the MESSAGE** — that is the whole reason the row
   * lives in this database (FR-036). A reply that exists with no intent is a customer who was answered
   * and never told; an intent with no reply is a delivery of nothing. Neither is representable when both
   * writes share one transaction.
   */
  async enqueue(
    tx: OutboxTx,
    input: { accountId: string; conversationId: string; messageId: string; channelId: string },
  ): Promise<void> {
    await tx.outboundMessage.create({
      data: {
        account_id: input.accountId,
        conversation_id: input.conversationId,
        message_id: input.messageId,
        channel_id: input.channelId,
      },
    });
  }

  /**
   * Claim the next due delivery, or `null` when there is none.
   *
   * ⚠️ **Deliberately NOT account-scoped, and this is the one such read here.** A tick belongs to no
   * account — the same exemption the SLA sweep and the export queue already carry, and documented in the
   * same terms: the row it returns then scopes every subsequent write. Selecting by account would need
   * the caller to already know which tenant has work, which is the question.
   */
  async claimNext(now: Date): Promise<ClaimedDelivery | null> {
    const candidate = (await this.prisma.outboundMessage.findFirst({
      where: { status: 'pending', next_attempt_at: { lte: now } },
      // Oldest first, so a row that has been waiting does not starve behind fresh ones.
      orderBy: { created_at: 'asc' },
      select: { id: true },
    })) as { id: string } | null;
    if (!candidate) return null;

    // ⭐ THE RACE IS DECIDED HERE. `status: 'pending'` in the predicate means the second claimer updates
    // zero rows and gets nothing — no lock, no coordination, no second system to agree with.
    const { count } = await this.prisma.outboundMessage.updateMany({
      where: { id: candidate.id, status: 'pending' },
      data: { status: 'sending', last_attempt_at: now },
    });
    if (count === 0) return null;

    return (await this.prisma.outboundMessage.findFirst({
      where: { id: candidate.id },
      select: {
        id: true,
        conversation_id: true,
        message_id: true,
        channel_id: true,
        attempts: true,
      },
    })) as ClaimedDelivery | null;
  }

  /**
   * Return claims nobody finished to the queue — the claimer died mid-send.
   *
   * ⚠️ This is the one place where at-most-once and at-least-once genuinely conflict: a process that
   * died AFTER the relay accepted the message but BEFORE deleting the row will send a second copy. The
   * window is the send call itself, it is unavoidable without a transaction spanning an SMTP session,
   * and the alternative — never reclaiming — loses replies permanently every time a pod restarts. Losing
   * a reply is silent and permanent; a rare duplicate is visible and survivable. Stated so the next
   * reader knows it was weighed rather than missed.
   */
  async reclaimStale(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - STALE_CLAIM_MS);
    const { count } = await this.prisma.outboundMessage.updateMany({
      where: { status: 'sending', last_attempt_at: { lt: cutoff } },
      data: { status: 'pending' },
    });
    return count;
  }

  /** A transport accepted it. The row goes; the message it delivered is the history. */
  async markSent(accountId: string, id: string): Promise<void> {
    await this.prisma.forAccount(accountId).outboundMessage.deleteMany({ where: { id } });
  }

  /**
   * Record a failed attempt: back to `pending` with a growing delay, or dead-lettered.
   *
   * ⚠️ **`errorClass` is a CLASS and the caller must never pass a relay's own text.** An SMTP rejection
   * quotes the envelope as a matter of course (`550 5.1.1 <someone@example.test> recipient rejected`),
   * and the envelope is the customer's address — so the text is dropped at the transport boundary and
   * only the class travels this far (FR-040).
   *
   * A dead-lettered row is left in `failed` for a person to find. Nothing deletes it: an answer the
   * customer never received is exactly the thing that must not disappear quietly.
   */
  async markAttemptFailed(
    accountId: string,
    id: string,
    input: { attempts: number; errorClass: string; retry: boolean; now: Date },
  ): Promise<void> {
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** input.attempts, BACKOFF_MAX_MS);
    await this.prisma.forAccount(accountId).outboundMessage.updateMany({
      where: { id },
      data: {
        status: input.retry ? 'pending' : 'failed',
        attempts: input.attempts,
        last_error_class: input.errorClass,
        last_attempt_at: input.now,
        // Set even on a dead letter: a human who resets the status must not be handed a row whose clock
        // says "try me a month ago" and have it retried instantly by the next tick.
        next_attempt_at: new Date(input.now.getTime() + delay),
      },
    });
  }
}
