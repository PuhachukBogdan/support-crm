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
  /** ⭐ Added in feature 028: the outbox row is tenant-owned data like every other table
   *  (Principle I), and only the caller knows which account caused the message. */
  accountId: string;
}

/** An invitation link addressed to an invited email (feature 010). The token is secret. */
export interface OutboundInvite {
  to: string; // invited email
  inviteToken: string; // "<invitationId>.<secret>" — secret; lives only in transit + the outbox
  invitationId: string;
  expiresAt: Date;
  /** ⭐ Added in feature 028 — see `OutboundLoginCode.accountId`. */
  accountId: string;
}

/**
 * A Prisma transaction client, as much of it as the outbox needs (feature 028).
 *
 * ⚠️ Typed structurally rather than imported from Prisma so that this port — the seam the domain
 * services depend on — does not acquire a dependency on the ORM.
 */
export interface EmailTxClient {
  outboundEmail: {
    create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
  };
}

export interface EmailPort {
  /**
   * @param tx  ⭐ **Added in feature 028, optional so every existing call site is unchanged** —
   *            the same widening `HttpPort` took when it grew a method. When a caller passes its
   *            transaction, the outbox row is written **inside it**, beside the `LoginCode` or
   *            `Invitation` it announces: either both exist or neither does. Without it the row is
   *            still written, just not joined — which is what unit tests and the in-memory adapter
   *            do.
   */
  sendLoginCode(message: OutboundLoginCode, tx?: EmailTxClient): Promise<void>;
  /** Deliver an invitation link (feature 010). The token is secret — never logged. */
  sendInvite(message: OutboundInvite, tx?: EmailTxClient): Promise<void>;
}

/** Nest DI token for the EmailPort (interfaces have no runtime token). */
export const EMAIL_PORT = Symbol('EMAIL_PORT');

/**
 * ⚠️ **TEST DOUBLE ONLY.** An in-memory outbox the unit specs inspect. It delivers nothing.
 *
 * ── The dev file sink was DELETED in feature 028 ────────────────────────────────────────────────
 * It used to append each delivered code as a JSON line to `LOGIN_CODE_DEV_SINK`, so a live round
 * could read a code without real SMTP. Real SMTP now exists (a catcher in compose), so the sink
 * was the weaker of two ways to obtain a code — and the weaker way was **a live one-time secret
 * sitting in a plaintext file inside a container**. Two ways to get a credential means the weaker
 * one outlives the reason it was created, so it is gone rather than merely unused;
 * `no-plaintext-sink.spec.ts` fails if it returns.
 *
 * This class stays because unit specs need an `EmailPort` that records without a database. Nothing
 * outside a test may reference it — `mail-structure.spec.ts` enforces that.
 */
export class OutboxEmailAdapter implements EmailPort {
  readonly outbox: OutboundLoginCode[] = [];
  readonly inviteOutbox: OutboundInvite[] = [];

  async sendLoginCode(message: OutboundLoginCode): Promise<void> {
    // Copy so a later mutation of the caller's object can't rewrite history.
    this.outbox.push({ ...message });
  }

  async sendInvite(message: OutboundInvite): Promise<void> {
    this.inviteOutbox.push({ ...message });
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
