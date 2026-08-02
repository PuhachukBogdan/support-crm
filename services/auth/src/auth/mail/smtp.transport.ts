import { Inject, Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { AUTH_CONFIG, parseAllowedRecipientDomains, type AuthConfig } from '../../config';
import {
  MailSendError,
  type MailErrorClass,
  type MailMessage,
  type MailTransport,
} from './mail-transport';

/**
 * SMTP over `nodemailer` (feature 028, research R7).
 *
 * ── The guard runs BEFORE the socket ────────────────────────────────────────────────────────────
 * FR-018 says "before contacting any mail host" because the harm is the connection itself: a
 * synthetic stand that reaches a real person's mailbox has already done the damage by the time the
 * send succeeds. Putting the check at the boundary also makes it impossible to bypass by adding a
 * caller — the same argument that keeps one `HttpPort` on the front end.
 *
 * ── Nothing the relay says survives this file ───────────────────────────────────────────────────
 * ⚠️ Every failure becomes a {@link MailErrorClass}. The original error is not wrapped, not
 * attached as a `cause`, and not logged here: SMTP errors quote the envelope, and the envelope
 * carries the recipient.
 */
@Injectable()
export class SmtpMailTransport implements MailTransport {
  private readonly allowedDomains: string[];
  private transporter?: Transporter;

  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    /** Seam for tests: a fake `sendMail` keeps the suite off the network entirely. */
    private readonly sendMail?: (message: {
      from: string;
      to: string;
      subject: string;
      text: string;
    }) => Promise<unknown>,
  ) {
    this.allowedDomains = parseAllowedRecipientDomains(cfg.MAIL_ALLOWED_RECIPIENT_DOMAINS);
  }

  /**
   * ⚠️ Empty list = unrestricted. Read the other way round it would silently stop all mail in
   * production, where an empty list is the legitimate configuration (FR-019) — and mail that stops
   * looks exactly like mail that is merely slow.
   */
  private isAllowed(to: string): boolean {
    if (this.allowedDomains.length === 0) return true;
    const domain = to.split('@').pop()?.trim().toLowerCase() ?? '';
    return this.allowedDomains.includes(domain);
  }

  private get send$(): (m: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }) => Promise<unknown> {
    if (this.sendMail) return this.sendMail;
    // Built lazily so constructing the service never opens anything — a unit test that only
    // exercises the guard must not need a mail host to exist.
    this.transporter ??= createTransport({
      host: this.cfg.MAIL_HOST,
      port: this.cfg.MAIL_PORT,
      secure: this.cfg.MAIL_SECURE,
      auth: this.cfg.MAIL_USER
        ? { user: this.cfg.MAIL_USER, pass: this.cfg.MAIL_PASSWORD }
        : undefined,
      // ⭐ TIMEOUTS, found by the first live failure test (2026-08-02). The library's defaults are
      // ~2 minutes, and a send against a stopped host simply HUNG: the outbox row stayed claimed
      // (`sending`) with no attempt recorded, so a failure that should be visible within a minute
      // (SC-007) was invisible for two, and the retry could not start until the claim went stale.
      //
      // Nothing was lost — the stale-claim sweep still recovers it — but "not lost" and "visible"
      // are different promises, and this feature made the second one.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return (m) => this.transporter!.sendMail(m);
  }

  async send(message: MailMessage): Promise<void> {
    if (!this.isAllowed(message.to)) {
      // Refused without a connection. Recorded by the caller; never silently dropped, because a
      // silent drop is indistinguishable from a broken relay and costs somebody a morning.
      throw new MailSendError('recipient_blocked');
    }

    try {
      await this.send$({
        from: this.cfg.MAIL_FROM,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    } catch (err) {
      throw new MailSendError(classify(err));
    }
  }
}

/**
 * Map a transport failure to a class. Deliberately coarse: the caller decides whether to retry,
 * and finer detail would only be useful if it were recorded — which it must not be.
 */
export function classify(err: unknown): MailErrorClass {
  const code = (err as { code?: string })?.code;
  const responseCode = (err as { responseCode?: number })?.responseCode;

  if (code === 'EAUTH') return 'auth_failed';
  if (typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600) {
    return 'refused';
  }
  // ECONNREFUSED · ETIMEDOUT · ENOTFOUND · ESOCKET · EDNS — and anything unrecognised. Unknown is
  // treated as retryable on purpose: giving up on a fault we do not understand loses a login code,
  // and the attempt ceiling stops it from looping for ever.
  return 'unreachable';
}
