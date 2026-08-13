/**
 * SMTP over `nodemailer` (feature 028 research R7, **moved here by feature 033** — research R7).
 *
 * ── The guards run BEFORE the socket ────────────────────────────────────────────────────────────
 * Both of them, and the reason is that the harm is the connection itself, not the delivery. Putting the
 * checks at this boundary also makes them impossible to bypass by adding a caller — which is exactly
 * what feature 033 did by adding a second sender.
 *
 * ── Nothing the relay says survives this file ───────────────────────────────────────────────────
 * ⚠️ Every failure becomes a {@link MailErrorClass}. The original error is not wrapped, not attached as
 * a `cause`, and not logged here: SMTP errors quote the envelope, and the envelope carries the
 * recipient (Principle IV).
 *
 * ⚠️ **A factory, not an `@Injectable()` class.** `libs/common` imports no framework; each service keeps
 * its own thin DI wrapper around this.
 */
import { createTransport, type Transporter } from 'nodemailer';
import { isHostAllowed, isRecipientAllowed } from './guards';
import {
  MailSendError,
  type MailErrorClass,
  type MailMessage,
  type MailTransport,
} from './mail-transport';

/** Everything the sender needs, and nothing about *why* a message exists. */
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  /** Default sender; a message's own `from` overrides it (a per-brand support address). */
  from: string;
  /** ⚠️ Empty = unrestricted (see `guards.ts`). */
  allowedRecipientDomains: readonly string[];
  /** ⚠️ Empty = unrestricted (see `guards.ts`). */
  allowedHosts: readonly string[];
}

/** The shape nodemailer is handed. Narrowed so nothing else can be smuggled onto the wire. */
type SendMailFn = (message: {
  from: string;
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}) => Promise<unknown>;

/**
 * @param sendMail Seam for tests: a fake keeps the suite off the network entirely.
 */
export function createSmtpSender(cfg: SmtpConfig, sendMail?: SendMailFn): MailTransport {
  let transporter: Transporter | undefined;

  const send$ = (): SendMailFn => {
    if (sendMail) return sendMail;
    // Built lazily so constructing the sender never opens anything — a unit test that only exercises
    // the guards must not need a mail host to exist.
    transporter ??= createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined,
      // ⭐ TIMEOUTS, found by feature 028's first live failure test (2026-08-02). The library's defaults
      // are ~2 minutes, and a send against a stopped host simply HUNG: the outbox row stayed claimed
      // with no attempt recorded, so a failure that should be visible within a minute was invisible for
      // two, and the retry could not start until the claim went stale. Nothing was lost — the
      // stale-claim sweep still recovers it — but "not lost" and "visible" are different promises.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    return (m) => transporter!.sendMail(m);
  };

  return {
    async send(message: MailMessage): Promise<void> {
      // Host first: "we may not talk to that server" is a bigger fact than "we may not write to that
      // person", and reporting the recipient when the destination itself is wrong sends whoever reads
      // the log looking at the customer.
      if (!isHostAllowed(cfg.host, cfg.allowedHosts)) {
        throw new MailSendError('host_blocked');
      }
      if (!isRecipientAllowed(message.to, cfg.allowedRecipientDomains)) {
        // Refused without a connection. Recorded by the caller; never silently dropped, because a
        // silent drop is indistinguishable from a broken relay and costs somebody a morning.
        throw new MailSendError('recipient_blocked');
      }

      try {
        await send$()({
          from: message.from ?? cfg.from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          ...(message.headers ? { headers: message.headers } : {}),
          ...(message.attachments ? { attachments: message.attachments } : {}),
        });
      } catch (err) {
        throw new MailSendError(classify(err));
      }
    },
  };
}

/**
 * Map a transport failure to a class. Deliberately coarse: the caller decides whether to retry, and
 * finer detail would only be useful if it were recorded — which it must not be.
 */
export function classify(err: unknown): MailErrorClass {
  const code = (err as { code?: string })?.code;
  const responseCode = (err as { responseCode?: number })?.responseCode;

  if (code === 'EAUTH') return 'auth_failed';
  if (typeof responseCode === 'number' && responseCode >= 500 && responseCode < 600) {
    return 'refused';
  }
  // ECONNREFUSED · ETIMEDOUT · ENOTFOUND · ESOCKET · EDNS — and anything unrecognised. Unknown is
  // treated as retryable on purpose: giving up on a fault we do not understand loses a login code, and
  // the attempt ceiling stops it from looping for ever.
  return 'unreachable';
}
