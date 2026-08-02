import { Inject, Injectable } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { AUTH_CONFIG, type AuthConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { CLOCK, type Clock } from './ports/clock';
import { EMAIL_PORT, type EmailPort } from './ports/email.port';

/** A staff account, resolved by login, that a code is issued for. */
export interface CodeSubject {
  id: string;
  account_id: string;
  email: string;
}

export interface IssuedChallenge {
  challengeId: string;
  /** Unix seconds. */
  codeExpiresAt: number;
}

/** Discriminated verify result — success carries the resolved identity, failure a reason. */
export type CodeVerifyResult =
  | { ok: true; userId: string; accountId: string }
  | { ok: false; reason: 'invalid' | 'expired' | 'consumed' | 'exhausted' };

// Unambiguous alphabet (no 0/O/1/I) for the emailed code — 6 chars by default.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * OtpService (feature 009, T016). Owns the one-time email code for step 2 of login:
 * generate → argon2-hash → persist `LoginCode` → deliver via the EmailPort (never logged —
 * Principle IV). Verification checks match, expiry (against the injectable clock), single-use,
 * and the attempt cap; a used/expired/over-attempted code is refused. Enforcement hardening
 * (challenge supersession, super-admin no-bypass) is completed in US2.
 */
@Injectable()
export class OtpService {
  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
  ) {}

  private generateCode(length: number): string {
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) {
      out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
    }
    return out;
  }

  /**
   * Issue a fresh challenge for a subject and email the code. Returns the opaque handle only.
   * `purpose` selects the flow: `login_2fa` (009), `activation` / `registration` (010).
   */
  async issueChallenge(
    subject: CodeSubject,
    purpose: string = 'login_2fa',
  ): Promise<IssuedChallenge> {
    // Supersede any prior unconsumed challenge for this user — at most ONE active challenge
    // exists at a time (data-model), so an earlier challenge_id can never be verified later
    // (it now reads as `consumed`). This closes a stale-challenge reuse window (US2 / SEC-2).
    await this.prisma.loginCode.updateMany({
      where: { user_id: subject.id, consumed_at: null },
      data: { consumed_at: this.clock.now() },
    });

    const challengeId = randomUUID();
    const code = this.generateCode(this.cfg.CODE_LENGTH);
    const codeHash = await argon2.hash(code, {
      type: argon2.argon2id,
      memoryCost: this.cfg.ARGON2_MEMORY_COST,
      timeCost: this.cfg.ARGON2_TIME_COST,
    });
    const expiresAt = new Date(this.clock.now().getTime() + this.cfg.CODE_TTL * 1000);

    // ⭐ Feature 028 — ONE TRANSACTION for the code and the intent to deliver it.
    //
    // Before this, the row was created and the port was called after it, with nothing joining
    // them. Either half could exist alone, and the half that matters — a code nobody will ever be
    // sent — presents to the person as a code that never arrives, which is the most confusing
    // failure this flow can produce.
    //
    // ⚠️ A failure here legitimately fails the sign-in step. FR-004 is about the mail HOST, not
    // about our own database: if we cannot record what we are about to send, we have not started
    // a sign-in, and saying otherwise would be a lie the person waits on.
    await this.prisma.$transaction(async (tx) => {
      await tx.loginCode.create({
        data: {
          account_id: subject.account_id,
          user_id: subject.id,
          challenge_id: challengeId,
          code_hash: codeHash,
          purpose,
          expires_at: expiresAt,
        },
      });

      // Deliver the clear code through the port. Never logged; the port records it and the send
      // happens after this transaction commits.
      await this.email.sendLoginCode(
        {
          to: subject.email,
          code,
          challengeId,
          purpose,
          expiresAt,
          accountId: subject.account_id,
        },
        tx,
      );
    });

    return { challengeId, codeExpiresAt: Math.floor(expiresAt.getTime() / 1000) };
  }

  /** Verify a submitted code for a challenge. Single-use, expiring, attempt-capped. */
  async verifyCode(challengeId: string, code: string): Promise<CodeVerifyResult> {
    const row = await this.prisma.loginCode.findUnique({ where: { challenge_id: challengeId } });
    if (!row) return { ok: false, reason: 'invalid' };
    if (row.consumed_at) return { ok: false, reason: 'consumed' };
    if (row.attempts >= this.cfg.CODE_MAX_ATTEMPTS) return { ok: false, reason: 'exhausted' };
    if (row.expires_at.getTime() <= this.clock.now().getTime()) {
      return { ok: false, reason: 'expired' };
    }

    const match = await argon2.verify(row.code_hash, code).catch(() => false);
    if (!match) {
      await this.prisma.loginCode.update({
        where: { id: row.id },
        data: { attempts: row.attempts + 1 },
      });
      return { ok: false, reason: 'invalid' };
    }

    // Consume — single-use (a replay of this code now returns `consumed`).
    await this.prisma.loginCode.update({
      where: { id: row.id },
      data: { consumed_at: this.clock.now() },
    });
    return { ok: true, userId: row.user_id, accountId: row.account_id };
  }

  /**
   * Verify the active code for a user + purpose (feature 010). Onboarding/registration never
   * expose a `challenge_id` to the caller — the user is resolved from the whitelisted email or the
   * invite, then the newest unconsumed code of that purpose is checked. Single-use, expiring,
   * attempt-capped — same guarantees as {@link verifyCode}.
   */
  async verifyCodeForUser(
    userId: string,
    code: string,
    purpose: string,
  ): Promise<CodeVerifyResult> {
    const row = await this.prisma.loginCode.findFirst({
      where: { user_id: userId, purpose, consumed_at: null },
      orderBy: { created_at: 'desc' },
    });
    if (!row) return { ok: false, reason: 'invalid' };
    if (row.attempts >= this.cfg.CODE_MAX_ATTEMPTS) return { ok: false, reason: 'exhausted' };
    if (row.expires_at.getTime() <= this.clock.now().getTime()) {
      return { ok: false, reason: 'expired' };
    }

    const match = await argon2.verify(row.code_hash, code).catch(() => false);
    if (!match) {
      await this.prisma.loginCode.update({
        where: { id: row.id },
        data: { attempts: row.attempts + 1 },
      });
      return { ok: false, reason: 'invalid' };
    }

    await this.prisma.loginCode.update({
      where: { id: row.id },
      data: { consumed_at: this.clock.now() },
    });
    return { ok: true, userId: row.user_id, accountId: row.account_id };
  }
}
