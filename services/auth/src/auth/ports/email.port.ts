/**
 * EmailPort seam (feature 009, Principle III / research R4).
 *
 * The one-time login code is delivered through this port, NOT written to logs (it is a secret —
 * Principle IV). The production adapter will enqueue a BullMQ job to the worker (real SMTP +
 * egress allow-list — a later, isolated change); this feature ships only the in-memory dev/test
 * adapter below, so there is no real outbound here.
 */

/** A one-time login code addressed to a staff email. The `code` is secret — never logged. */
export interface OutboundLoginCode {
  to: string; // recipient email (account identity)
  code: string; // the clear one-time code — secret; lives only in transit + the outbox
  challengeId: string;
  purpose: string; // e.g. "login_2fa"
  expiresAt: Date;
}

export interface EmailPort {
  sendLoginCode(message: OutboundLoginCode): Promise<void>;
}

/** Nest DI token for the EmailPort (interfaces have no runtime token). */
export const EMAIL_PORT = Symbol('EMAIL_PORT');

/**
 * Dev/test transport: records each code in an in-memory outbox the tests inspect. It NEVER logs
 * the code and performs no real outbound. Not for production.
 */
export class OutboxEmailAdapter implements EmailPort {
  readonly outbox: OutboundLoginCode[] = [];

  async sendLoginCode(message: OutboundLoginCode): Promise<void> {
    // Copy so a later mutation of the caller's object can't rewrite history.
    this.outbox.push({ ...message });
  }

  /** The most recently delivered code (test convenience). */
  last(): OutboundLoginCode | undefined {
    return this.outbox[this.outbox.length - 1];
  }

  /** All codes delivered to a given recipient. */
  for(email: string): OutboundLoginCode[] {
    return this.outbox.filter((m) => m.to === email);
  }

  clear(): void {
    this.outbox.length = 0;
  }
}
