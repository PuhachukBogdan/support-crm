import { Inject, Injectable, Logger } from '@nestjs/common';
import { AUTH_CONFIG, type AuthConfig } from '../../config';
import { PrismaService } from '../../prisma.service';
import { CLOCK, type Clock } from '../ports/clock';
import { MAIL_TRANSPORT, MailSendError, type MailTransport } from './mail-transport';
import { renderInvitation, renderLoginCode, renderRecovery, type RenderContext } from './render';

/**
 * The outbox (feature 028, data-model §2).
 *
 * ── The one guarantee this file exists for ──────────────────────────────────────────────────────
 * A row is written **inside the caller's transaction**, beside the `LoginCode` or the `Invitation`
 * it announces. Either both exist or neither does. "A code exists that nobody will ever send"
 * — the failure that presents to a person as a code that never arrives — is unrepresentable.
 *
 * ── What is never written down ──────────────────────────────────────────────────────────────────
 * ⚠️ Every log line here carries the recipient, the purpose and an error **class**. Never the code,
 * never the token, never the rendered body, never the relay's own sentence (FR-012, FR-013).
 */

/** A row claimed for sending. Only what the renderer and the transport need. */
interface Claimed {
  id: string;
  to_email: string;
  purpose: string;
  payload_json: unknown;
  expires_at: Date;
  attempts: number;
}

/** Failures worth trying again. `refused` and `recipient_blocked` will never change their mind. */
const RETRYABLE = new Set(['unreachable', 'auth_failed']);

/** How long a claim may sit before the sweep assumes the claimer died. */
const STALE_CLAIM_MS = 120_000;

export interface EnqueueInput {
  accountId: string;
  to: string;
  purpose: 'login_code' | 'invitation' | 'recovery';
  payload: Record<string, unknown>;
  expiresAt: Date;
}

/** The subset of the Prisma client a transaction hands to a callback. */
type TxClient = {
  outboundEmail: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
};

@Injectable()
export class OutboundEmailService {
  private readonly logger = new Logger(OutboundEmailService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(MAIL_TRANSPORT) private readonly transport: MailTransport,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Record the intent to send. **Call this inside the transaction that writes the thing being
   * announced** — that is the whole point of the row living in this database.
   */
  async enqueue(tx: TxClient, input: EnqueueInput): Promise<string> {
    const row = await tx.outboundEmail.create({
      data: {
        account_id: input.accountId,
        to_email: input.to,
        purpose: input.purpose,
        payload_json: input.payload,
        expires_at: input.expiresAt,
      },
    });
    return row.id;
  }

  /**
   * Try to send one specific row now. Used by the immediate attempt after a request completes.
   * Never throws: a failure is a row, because the caller is not waiting and has nowhere to put an
   * exception (FR-004).
   */
  async attemptOne(id: string): Promise<void> {
    const claimed = await this.claimById(id);
    if (claimed) await this.deliver(claimed);
  }

  /**
   * Claim and send up to `batch` due rows. Driven by the worker's tick, which fires once across
   * replicas — the reason the tick exists at all rather than a `setInterval` in this service.
   */
  async sendDue(batch: number): Promise<{ attempted: number; sent: number; failed: number }> {
    await this.reclaimStale();

    let attempted = 0;
    let sent = 0;
    let failed = 0;

    for (let i = 0; i < batch; i += 1) {
      const claimed = await this.claimNext();
      if (!claimed) break;
      attempted += 1;
      const ok = await this.deliver(claimed);
      if (ok) sent += 1;
      else failed += 1;
    }

    return { attempted, sent, failed };
  }

  /**
   * `pending → sending` as a CONDITIONAL update: two ticks, or a tick racing the immediate
   * attempt, both try and exactly one wins. No extra bookkeeping is needed for idempotency — the
   * same mechanism feature 017 used for exports.
   */
  private async claimById(id: string): Promise<Claimed | null> {
    const now = this.clock.now();
    const { count } = await this.prisma.outboundEmail.updateMany({
      where: { id, status: 'pending' },
      data: { status: 'sending', last_attempt_at: now },
    });
    if (count === 0) return null;
    return (await this.prisma.outboundEmail.findUnique({ where: { id } })) as Claimed | null;
  }

  private async claimNext(): Promise<Claimed | null> {
    const candidate = await this.prisma.outboundEmail.findFirst({
      where: { status: 'pending' },
      orderBy: { created_at: 'asc' },
      select: { id: true },
    });
    return candidate ? this.claimById(candidate.id) : null;
  }

  /** A claim nobody finished — the claimer died. Without this, a crash loses what was in flight. */
  private async reclaimStale(): Promise<void> {
    const cutoff = new Date(this.clock.now().getTime() - STALE_CLAIM_MS);
    await this.prisma.outboundEmail.updateMany({
      where: { status: 'sending', last_attempt_at: { lt: cutoff } },
      data: { status: 'pending' },
    });
  }

  /** @returns true when a transport accepted the message. Never throws. */
  private async deliver(row: Claimed): Promise<boolean> {
    // ⚠️ Abandon rather than send. A code that can no longer be typed is worse than no code: the
    // person types it and is told it is wrong, and goes looking for a fault in themselves.
    if (row.expires_at.getTime() <= this.clock.now().getTime()) {
      await this.markFailed(row, 'expired');
      return false;
    }

    let message: { to: string; subject: string; text: string };
    try {
      // ⚠️ The recipient is taken from the ROW, never from the payload. The row's address was
      // copied from the record that caused the message; a payload is data the renderer reads.
      message = { to: row.to_email, ...this.render(row) };
    } catch {
      // A payload the renderer cannot use will never become usable. Nothing of it is logged.
      await this.markFailed(row, 'refused');
      return false;
    }

    try {
      await this.transport.send(message);
      // ⭐ DELETED, not marked. Kept rows would build, in the clear, a record of who signed in and
      // when — in a table that also holds secrets. Nobody asked for that record.
      await this.prisma.outboundEmail.delete({ where: { id: row.id } });
      this.logger.log(
        `mail sent purpose=${row.purpose} to=${row.to_email} attempts=${row.attempts + 1}`,
      );
      return true;
    } catch (err) {
      const errorClass = err instanceof MailSendError ? err.errorClass : 'unreachable';
      const attempts = row.attempts + 1;
      const retry = RETRYABLE.has(errorClass) && attempts < this.cfg.MAIL_MAX_ATTEMPTS;
      await this.prisma.outboundEmail.update({
        where: { id: row.id },
        data: {
          status: retry ? 'pending' : 'failed',
          attempts,
          last_error_class: errorClass,
          last_attempt_at: this.clock.now(),
        },
      });
      // The recipient, the purpose, the class, the count. Nothing else exists to log.
      this.logger.warn(
        `mail ${retry ? 'retrying' : 'failed'} purpose=${row.purpose} to=${row.to_email} ` +
          `class=${errorClass} attempts=${attempts}`,
      );
      return false;
    }
  }

  private render(row: Claimed) {
    const ctx: RenderContext = {
      brandName: this.cfg.MAIL_BRAND_NAME,
      appBaseUrl: this.cfg.APP_BASE_URL,
    };
    const payload = row.payload_json as Record<string, unknown>;
    const expiresAtMs = row.expires_at.getTime();

    if (row.purpose === 'login_code') {
      return renderLoginCode({ code: String(payload.code), expiresAtMs }, ctx);
    }
    if (row.purpose === 'invitation') {
      return renderInvitation({ inviteToken: String(payload.inviteToken), expiresAtMs }, ctx);
    }
    // ⭐ W36 / 041: the recovery link. Third purpose, same pipeline — the interceptor on the stand and a
    // real relay differ in nothing but destination, which is what makes «the mechanism is complete while
    // Q38 is open» an honest claim rather than a hope.
    if (row.purpose === 'recovery') {
      return renderRecovery({ recoveryToken: String(payload.recoveryToken), expiresAtMs }, ctx);
    }
    throw new Error(`unknown purpose: ${row.purpose}`);
  }

  private async markFailed(row: Claimed, errorClass: string): Promise<void> {
    await this.prisma.outboundEmail.update({
      where: { id: row.id },
      data: {
        status: 'failed',
        last_error_class: errorClass,
        attempts: row.attempts + 1,
        last_attempt_at: this.clock.now(),
      },
    });
    this.logger.warn(
      `mail abandoned purpose=${row.purpose} to=${row.to_email} class=${errorClass}`,
    );
  }
}
