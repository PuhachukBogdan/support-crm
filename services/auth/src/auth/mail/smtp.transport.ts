import { Inject, Injectable } from '@nestjs/common';
import {
  createSmtpSender,
  parseAllowedRecipientDomains,
  parseHostAllowList,
  type MailMessage,
  type MailTransport,
} from '@crm/common';
import { AUTH_CONFIG, type AuthConfig } from '../../config';

/**
 * Auth's Nest wrapper around the shared SMTP sender.
 *
 * ⚠️ **THE IMPLEMENTATION MOVED** to `libs/common/src/mail/smtp.sender.ts` (feature 033, research R7).
 * What stays here is the DI shell and auth's own configuration mapping — `libs/common` is deliberately
 * framework-free, so an `@Injectable()` class could not move with it.
 *
 * Behaviour is unchanged, and feature 028's `smtp.transport.spec.ts` is the proof: it constructs this
 * class with the same two arguments and asserts the same outcomes, and it passes **unmodified**.
 *
 * ── What feature 033 added for auth, without auth asking ────────────────────────────────────────
 * The **host** allow-list. Auth opens an outbound connection to a relay, so Principle III applies to it
 * exactly as it does to the new channel sender; the same variable governs both, because two allow-lists
 * for one boundary is the arrangement that ends with them disagreeing. `MAIL_ALLOWED_HOSTS` is absent in
 * every existing deployment, and absent means unrestricted — so nothing changes until somebody sets it.
 */
@Injectable()
export class SmtpMailTransport implements MailTransport {
  private readonly sender: MailTransport;

  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    /** Seam for tests: a fake `sendMail` keeps the suite off the network entirely. */
    sendMail?: (message: {
      from: string;
      to: string;
      subject: string;
      text: string;
    }) => Promise<unknown>,
  ) {
    this.sender = createSmtpSender(
      {
        host: cfg.MAIL_HOST,
        port: cfg.MAIL_PORT,
        secure: cfg.MAIL_SECURE,
        user: cfg.MAIL_USER || undefined,
        password: cfg.MAIL_PASSWORD,
        from: cfg.MAIL_FROM,
        allowedRecipientDomains: parseAllowedRecipientDomains(cfg.MAIL_ALLOWED_RECIPIENT_DOMAINS),
        allowedHosts: parseHostAllowList(process.env.MAIL_ALLOWED_HOSTS),
      },
      sendMail,
    );
  }

  send(message: MailMessage): Promise<void> {
    return this.sender.send(message);
  }
}

/**
 * ⚠️ Re-exported from shared code — see the class note. Feature 028's spec imports `classify` from this
 * path and asserts the same mapping table, unmodified.
 */
export { classify } from '@crm/common';
