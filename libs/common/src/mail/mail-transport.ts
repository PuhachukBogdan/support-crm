/**
 * The mail transport seam (feature 028 contracts §2, **moved here by feature 033** — research R7).
 *
 * ── One rule, and everything here follows from it ───────────────────────────────────────────────
 * **What reaches the transport is text somebody already decided to send.** No purpose, no code, no
 * token, no account. A transport that could tell a login code from an invitation would eventually
 * branch on it, and then the thing that knows *how* would start knowing *why*.
 *
 * ── Why it moved out of the auth service ────────────────────────────────────────────────────────
 * Feature 033 adds a second sender: conversation replies, owned by chats. `smtp.transport.ts` argues
 * for itself that putting the egress check at the boundary *"makes it impossible to bypass by adding a
 * caller"* — and 033 is precisely the caller that would have bypassed it. A second copy in chats would
 * turn the one security boundary Principle III depends on into a convention, with two allow-lists to
 * keep in agreement.
 *
 * ⚠️ `libs/common` is deliberately **framework-free** — nothing here imports `@nestjs/*`. That is why
 * the *sender* is a factory (`createSmtpSender`) rather than an `@Injectable()` class: each service
 * keeps its own thin DI wrapper. Discovered while implementing R7, which had assumed the class could
 * move as-is.
 */

/** One attachment on an outbound message (feature 033 — email channel replies carry files). */
export interface MailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface MailMessage {
  to: string;
  subject: string;
  /** Plain text. There is deliberately no HTML alternative (028 FR-007). */
  text: string;
  /**
   * ── The three optional fields below are feature 033's additions ────────────────────────────────
   * Absent for every message auth sends, so its behaviour is byte-identical to before the move.
   */
  /** Overrides the transport's configured sender. A per-brand support address (033), never a default. */
  from?: string;
  /**
   * Extra headers. 033 uses `Message-ID`, `In-Reply-To` and `References` — without them a customer's
   * reply weeks later cannot be threaded, and threading cannot be reconstructed after the fact.
   */
  headers?: Record<string, string>;
  attachments?: MailAttachment[];
}

/**
 * ⚠️ A CLASS, never the relay's own sentence.
 *
 * SMTP rejections quote the envelope as a matter of course — `550 5.1.1 <someone@example.test>
 * recipient rejected` — and an envelope carries a recipient, sometimes more. Everything downstream
 * records and logs this enum; the original text is dropped at the boundary.
 */
export type MailErrorClass =
  | 'unreachable' // no connection, or the conversation died — worth retrying
  | 'auth_failed' // the relay refused OUR credentials — retrying will not help, but it is not the message's fault
  | 'refused' // the relay rejected the message — permanent
  | 'recipient_blocked' // our own guard refused the RECIPIENT, before any connection
  /**
   * Our own guard refused the **destination host**, before any connection (feature 033, FR-041).
   *
   * Distinct from `recipient_blocked` on purpose: one means "we may not write to that person", the
   * other "we may not talk to that server". Collapsing them would make a misconfigured relay look like
   * a blocked customer, and somebody would go looking for the customer.
   */
  | 'host_blocked'
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

/**
 * Nest DI token — interfaces have no runtime token.
 *
 * A bare `Symbol`, so declaring it costs `libs/common` no framework dependency; the services that
 * bind it are the ones that know about Nest.
 */
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
