/**
 * The mail transport seam (feature 028, contracts §2).
 *
 * ── One rule, and everything here follows from it ───────────────────────────────────────────────
 * **What reaches the transport is text somebody already decided to send.** No purpose, no code, no
 * token, no account. A transport that could tell a login code from an invitation would eventually
 * branch on it, and then the thing that knows *how* would start knowing *why*.
 */

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text. There is deliberately no HTML alternative (FR-007). */
  text: string;
}

/**
 * ⚠️ A CLASS, never the relay's own sentence.
 *
 * SMTP rejections quote the envelope as a matter of course — `550 5.1.1 <someone@example.test>
 * recipient rejected` — and an envelope carries a recipient, sometimes more. Everything downstream
 * records and logs this enum; the original text is dropped at the boundary, the same way the front
 * end's `HttpPort` drops an unparseable body rather than carrying it somewhere it might be shown.
 */
export type MailErrorClass =
  | 'unreachable' // no connection, or the conversation died — worth retrying
  | 'auth_failed' // the relay refused OUR credentials — retrying will not help, but it is not the message's fault
  | 'refused' // the relay rejected the message — permanent
  | 'recipient_blocked' // our own guard refused it, before any connection
  | 'expired'; // what it carries died before we could send it

/** Carries the class and nothing else. Its `message` is the class name, on purpose. */
export class MailSendError extends Error {
  constructor(readonly errorClass: MailErrorClass) {
    super(errorClass);
    this.name = 'MailSendError';
  }
}

export interface MailTransport {
  /** Resolves when a mail host ACCEPTED the message. Throws {@link MailSendError} otherwise. */
  send(message: MailMessage): Promise<void>;
}

/** Nest DI token — interfaces have no runtime token. */
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
