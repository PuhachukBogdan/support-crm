/**
 * EmailPort seam (feature 009, Principle III / research R4).
 *
 * The one-time login code is delivered through this port, NOT written to logs (it is a secret —
 * Principle IV). The production adapter will enqueue a BullMQ job to the worker (real SMTP +
 * egress allow-list — a later, isolated change); this feature ships only the in-memory dev/test
 * adapter below, so there is no real outbound here.
 */
import { appendFileSync } from 'node:fs';

/** A one-time login code addressed to a staff email. The `code` is secret — never logged. */
export interface OutboundLoginCode {
  to: string; // recipient email (account identity)
  code: string; // the clear one-time code — secret; lives only in transit + the outbox
  challengeId: string;
  purpose: string; // e.g. "login_2fa"
  expiresAt: Date;
}

/** An invitation link addressed to an invited email (feature 010). The token is secret. */
export interface OutboundInvite {
  to: string; // invited email
  inviteToken: string; // "<invitationId>.<secret>" — secret; lives only in transit + the outbox
  invitationId: string;
  expiresAt: Date;
}

export interface EmailPort {
  sendLoginCode(message: OutboundLoginCode): Promise<void>;
  /** Deliver an invitation link (feature 010). The token is secret — never logged. */
  sendInvite(message: OutboundInvite): Promise<void>;
}

/** Nest DI token for the EmailPort (interfaces have no runtime token). */
export const EMAIL_PORT = Symbol('EMAIL_PORT');

/**
 * Dev/test transport: records each code in an in-memory outbox the tests inspect. It NEVER logs
 * the code and performs no real outbound. Not for production.
 *
 * Optional dev file sink: when a path is supplied (via `LOGIN_CODE_DEV_SINK` by default), each
 * delivered code is also appended as one JSON line to that file, so a LOCAL/DEV flow (e.g. the
 * Track-B live round-trip) can read the code without real SMTP and without logging the secret —
 * the outbox is not the app log (Principle IV). Unset in tests/production → no file is touched.
 */
export class OutboxEmailAdapter implements EmailPort {
  readonly outbox: OutboundLoginCode[] = [];
  readonly inviteOutbox: OutboundInvite[] = [];

  constructor(private readonly devSinkPath = process.env.LOGIN_CODE_DEV_SINK) {}

  async sendLoginCode(message: OutboundLoginCode): Promise<void> {
    // Copy so a later mutation of the caller's object can't rewrite history.
    this.outbox.push({ ...message });
    if (this.devSinkPath) {
      appendFileSync(
        this.devSinkPath,
        JSON.stringify({
          to: message.to,
          code: message.code,
          challengeId: message.challengeId,
          purpose: message.purpose,
          expiresAt: message.expiresAt.toISOString(),
        }) + '\n',
      );
    }
  }

  async sendInvite(message: OutboundInvite): Promise<void> {
    this.inviteOutbox.push({ ...message });
    if (this.devSinkPath) {
      appendFileSync(
        this.devSinkPath,
        JSON.stringify({
          to: message.to,
          inviteToken: message.inviteToken,
          invitationId: message.invitationId,
          purpose: 'invitation',
          expiresAt: message.expiresAt.toISOString(),
        }) + '\n',
      );
    }
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
