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
/**
 * Resolve WHERE the channel's replies go — exported because it is the part worth asserting, and the
 * host is otherwise unobservable: `createSmtpSender` builds its transporter lazily, so a test holding a
 * fake `sendMail` never touches the address it would have dialled (feature 033, T-fix).
 *
 * ── Why the channel relay has its own address (found by the W3 live round, 2026-08-05) ──────────
 * `MAIL_*` alone cannot express this deployment, and the file that proves it is `compose.yaml`: its
 * `greenmail` block says *"it holds no login codes (those stay in mailpit)"*. Two destinations were
 * always intended — the channel's mailbox and the code catcher — and one variable cannot name both.
 * `live-w3.sh` then reads the agent's reply out of **greenmail** over IMAP while reading login codes out
 * of **mailpit** over REST, so with a single `MAIL_HOST` the round cannot pass whichever leg loses.
 *
 * ⚠️ It is not a stand-only concern, which is why the fix is config and not a test fixture. In production
 * the split is the ordinary case: a brand's support mailbox lives with a mail PROVIDER (and a reply must
 * leave through it, or it fails that domain's SPF and never appears in the mailbox's own Sent), while
 * codes and invitations leave through a transactional relay as `no-reply@`. Different servers, different
 * credentials.
 *
 * ── All-or-nothing, deliberately ────────────────────────────────────────────────────────────────
 * ⚠️ Naming `CHANNEL_SMTP_HOST` selects the channel's OWN relay, and then **nothing falls back to
 * `MAIL_*`** — not the port, not the user, not the password. A per-key fallback would send the
 * transactional relay's *credentials* to a different company's server the first time somebody set the
 * host and forgot the user. That is a credential disclosure produced by a convenience, so the seam is the
 * host: either this relay is configured, or it is the one `MAIL_*` describes.
 *
 * The egress allow-list is the one thing that does NOT split (`MAIL_ALLOWED_HOSTS`): one list for one
 * boundary, so a deployment with two relays must name both hosts in it. Two lists to keep in agreement is
 * exactly what moving the sender into `libs/common` existed to prevent.
 */
export function resolveChannelSmtpConfig(env: NodeJS.ProcessEnv = process.env) {
  const ownHost = (env.CHANNEL_SMTP_HOST ?? '').trim();
  const own = ownHost !== '';
  const port = (raw: string | undefined, fallback: number) => Number(raw ?? fallback) || fallback;
  const isTrue = (raw: string | undefined) => (raw ?? '').trim().toLowerCase() === 'true';
  return {
    host: own ? ownHost : (env.MAIL_HOST ?? '').trim(),
    // 587 when this relay is its own: a deployment that names a provider means submission, not the
    // catcher's 1025. The stand names 3025 explicitly, and `compose.yaml` lists the key so it is visible.
    port: own ? port(env.CHANNEL_SMTP_PORT, 587) : port(env.MAIL_PORT, 1025),
    secure: own ? isTrue(env.CHANNEL_SMTP_SECURE) : isTrue(env.MAIL_SECURE),
    user: (own ? (env.CHANNEL_SMTP_USER ?? '').trim() : (env.MAIL_USER ?? '').trim()) || undefined,
    password: (own ? env.CHANNEL_SMTP_PASSWORD : env.MAIL_PASSWORD) ?? '',
    // The fallback sender only. A brand's own address rides on the message.
    from: (env.CHANNEL_EMAIL_ADDRESS ?? env.MAIL_FROM ?? '').trim(),
    allowedRecipientDomains: parseAllowedRecipientDomains(env.MAIL_ALLOWED_RECIPIENT_DOMAINS),
    // ⚠️ `MAIL_ALLOWED_HOSTS`, the same variable auth reads and the same one the IMAP reader reads.
    // ONE list for one boundary — see `services/worker/src/config.ts` for why it is not
    // channel-scoped.
    allowedHosts: parseHostAllowList(env.MAIL_ALLOWED_HOSTS),
  };
}

@Injectable()
export class ChatsSmtpTransport implements MailTransport {
  private readonly sender: MailTransport;

  constructor(
    /** Seam for tests: a fake `sendMail` keeps the suite off the network entirely. */
    sendMail?: (message: Record<string, unknown>) => Promise<unknown>,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.sender = createSmtpSender(resolveChannelSmtpConfig(env), sendMail as never);
  }

  send(message: MailMessage): Promise<void> {
    return this.sender.send(message);
  }
}
