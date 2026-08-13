import { Injectable } from '@nestjs/common';
import {
  createSmtpSender,
  parseAllowedRecipientDomains,
  parseHostAllowList,
  type MailMessage,
  type MailTransport,
} from '@crm/common';

/**
 * Chats' Nest wrapper around the SHARED SMTP sender (feature 033, research R7/R8 — FR-041/FR-042).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **THE SENDER ITSELF IS NOT COPIED**, and that is the whole reason it was moved to `libs/common`
 * during this feature. `smtp.transport.ts` in auth argues that putting the egress check at the boundary
 * *"makes it impossible to bypass by adding a caller"* — and this file is exactly the caller that would
 * have bypassed it. A second implementation here would have turned the one boundary Principle III depends
 * on into a convention, with two allow-lists to keep in agreement.
 *
 * So this is a DI shell and a configuration mapping, nothing more. Both guards — recipient domains and
 * the **host** allow-list — run inside the shared sender, before any socket is opened.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── The transport is CONFIGURATION, which is what unblocks open question O5 (FR-042) ────────────
 * Where the mail actually goes is decided by `MAIL_*`. The stand's local relay today and a real provider
 * later is a settings change with no code path of its own — and no stand-only branch, which is the trap
 * `gotchas/mailpit-speaks-no-imap` records for the inbound side.
 *
 * ⚠️ **The `from` is per-BRAND and comes from the message**, not from here (white-label rule 6). This
 * shell supplies only the fallback for a deployment that configured no channel address.
 */
@Injectable()
export class ChatsSmtpTransport implements MailTransport {
  private readonly sender: MailTransport;

  constructor(
    /** Seam for tests: a fake `sendMail` keeps the suite off the network entirely. */
    sendMail?: (message: Record<string, unknown>) => Promise<unknown>,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.sender = createSmtpSender(
      {
        host: (env.MAIL_HOST ?? '').trim(),
        port: Number(env.MAIL_PORT ?? 1025) || 1025,
        secure: (env.MAIL_SECURE ?? '').trim().toLowerCase() === 'true',
        user: (env.MAIL_USER ?? '').trim() || undefined,
        password: env.MAIL_PASSWORD ?? '',
        // The fallback sender only. A brand's own address rides on the message.
        from: (env.CHANNEL_EMAIL_ADDRESS ?? env.MAIL_FROM ?? '').trim(),
        allowedRecipientDomains: parseAllowedRecipientDomains(env.MAIL_ALLOWED_RECIPIENT_DOMAINS),
        // ⚠️ `MAIL_ALLOWED_HOSTS`, the same variable auth reads and the same one the IMAP reader reads.
        // ONE list for one boundary — see `services/worker/src/config.ts` for why it is not
        // channel-scoped.
        allowedHosts: parseHostAllowList(env.MAIL_ALLOWED_HOSTS),
      },
      sendMail as never,
    );
  }

  send(message: MailMessage): Promise<void> {
    return this.sender.send(message);
  }
}
