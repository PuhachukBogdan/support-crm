import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import type {
  EmailPort,
  EmailTxClient,
  OutboundInvite,
  OutboundLoginCode,
} from '../ports/email.port';
import { OutboundEmailService } from './outbound-email.service';

/**
 * The `EmailPort` binding that actually delivers (feature 028).
 *
 * ── What "sent" means here, and what it does not ────────────────────────────────────────────────
 * These methods resolve when the message has been **recorded**, not when it has been delivered.
 * The interface has always been shaped that way and now it matters: the caller is inside a
 * request, and FR-004 forbids it waiting on a mail host.
 *
 * ── ⚠️ The immediate attempt is unawaited, and its rejection is HANDLED ─────────────────────────
 * Not awaiting is the point (FR-004). But an unhandled rejection is printed by the runtime **with
 * the reason attached**, and a reason from a mail library can carry the envelope and the body —
 * which would defeat FR-012 through the one path nobody writes a test for. `attemptOne` therefore
 * never throws, and the `catch` here exists as a second wall rather than as a formality.
 *
 * ⓘ **A short delay, not `setImmediate`.** The row is invisible to another connection until the
 * caller's transaction commits, and the commit is a database round trip that finishes *after* the
 * current event-loop turn. `setImmediate` therefore loses the race reliably rather than
 * occasionally: measured on the stand, every first attempt found nothing and the message waited a
 * full sweep interval. The failure mode was **latency, never loss** — exactly what the row exists
 * to guarantee — but a code arriving in fifteen seconds instead of one is a worse product for
 * somebody signing in twenty times a day.
 *
 * ⚠️ The delay is a nudge past the commit, **not** a synchronisation mechanism. If it still loses,
 * the sweep delivers. Nothing here may ever depend on the timing being enough.
 */
const COMMIT_NUDGE_MS = 250;
@Injectable()
export class QueueingEmailAdapter implements EmailPort {
  constructor(
    @Inject(OutboundEmailService) private readonly outbox: OutboundEmailService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async sendLoginCode(message: OutboundLoginCode, tx?: EmailTxClient): Promise<void> {
    const id = await this.outbox.enqueue(tx ?? (this.prisma as unknown as EmailTxClient), {
      accountId: message.accountId,
      to: message.to,
      purpose: 'login_code',
      payload: { code: message.code },
      expiresAt: message.expiresAt,
    });
    this.fireAndForget(id);
  }

  async sendInvite(message: OutboundInvite, tx?: EmailTxClient): Promise<void> {
    const id = await this.outbox.enqueue(tx ?? (this.prisma as unknown as EmailTxClient), {
      accountId: message.accountId,
      to: message.to,
      purpose: 'invitation',
      payload: { inviteToken: message.inviteToken },
      expiresAt: message.expiresAt,
    });
    this.fireAndForget(id);
  }

  private fireAndForget(id: string): void {
    const timer = setTimeout(() => {
      void this.outbox.attemptOne(id).catch(() => {
        // Deliberately empty, and deliberately not logged. `attemptOne` already records every
        // outcome with a class; anything reaching here is a defect in that method, and logging the
        // error object is exactly how the message body would escape.
      });
    }, COMMIT_NUDGE_MS);
    // Do not hold the process open for a message the sweep would deliver anyway.
    timer.unref?.();
  }
}
