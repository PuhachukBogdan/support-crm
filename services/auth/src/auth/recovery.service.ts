import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { RecoveryReason } from '@crm/common';
import { AUTH_CONFIG, type AuthConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import { CLOCK, type Clock } from './ports/clock';
import { TokenService } from './token.service';
import { RateLimiter } from './rate-limiter';
import { EMAIL_PORT, type EmailPort } from './ports/email.port';
import { PasswordService } from './password.service';

/**
 * ⭐ W36 / feature 041 (roadmap 3.18) — **password recovery: the canonical account-takeover path.**
 *
 * ── The one property everything here is arranged around ─────────────────────────────────────────
 * **The answer to a request never varies.** Known address, unknown address, a person who never set a
 * password, a person who may no longer sign in, a request over the limit — one response shape, and the
 * difference exists in the audit trail and NOWHERE else. A form that answers differently for a known
 * address is a directory of who works here, published to the internet.
 *
 * That is why `request()` returns `void` rather than an outcome: there is no value to leak, and a
 * caller cannot accidentally forward one.
 *
 * ── The token is not the login code, and cannot be ─────────────────────────────────────────────
 * It lives in `RecoveryToken`, not in `LoginCode`. `VerifyLoginCode` mints a session; a recovery secret
 * in that table would be one forgotten `purpose` check away from a password-free login. Roadmap 3.18
 * states the rule and the schema records why the reservation there is dead.
 *
 * ── What completing it does and does not do ────────────────────────────────────────────────────
 * It sets a password through the ONE writer (`PasswordService`) and issues **nothing** — no session, no
 * token, no cookie. The two-step login still runs afterwards. That overrides roadmap 8.11's «and signs
 * them in», deliberately (spec 041 FR-009): a link that both sets a password and hands out a session
 * makes the email a complete authentication factor by itself.
 */

export type CompleteRecoveryOutcome =
  | { status: 'ok'; revokedCount: number }
  | { status: 'bad_token' }
  | { status: 'expired' }
  | { status: 'already_used' }
  | { status: 'weak_password'; failures: string[] }
  | { status: 'not_eligible' };

/** A person may recover only if they could sign in at all. A leaver must not walk back in by mailbox. */
const ELIGIBLE_STATUS = new Set(['active']);

@Injectable()
export class RecoveryService {
  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(RateLimiter) private readonly rate: RateLimiter,
    @Inject(EMAIL_PORT) private readonly email: EmailPort,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  /**
   * Ask for a link. **Always** ends the same way from the outside.
   *
   * ⚠️ The work is deliberately NOT conditional on the address existing, as far as cost goes: the known
   * path spends an argon2 hash (issuing a token), so the unknown path spends one too, on a constant.
   * That equalises the **dominant** cost. It does not make the endpoint constant-time and this comment
   * does not pretend otherwise — a claim of constant time would need every branch measured, and the
   * honest bound is «the expensive step happens either way».
   */
  async request(email: string, sourceRef: string): Promise<void> {
    const address = email.trim().toLowerCase();
    const valueHash = this.hashAddress(address);

    // The SOURCE limit is checked first and applies to everybody: it is what bounds somebody walking a
    // list of addresses through the form. It needs no account, which matters — see the comment below.
    const sourceOk = this.rate.allow(
      `recovery:src:${sourceRef || 'unknown'}`,
      this.cfg.RECOVERY_SOURCE_RATE_MAX,
      this.cfg.RECOVERY_RATE_WINDOW,
    );

    const user = sourceOk ? await this.prisma.user.findFirst({ where: { email: address } }) : null;

    /**
     * ⚠️⚠️ **AN ADDRESS THAT BELONGS TO NOBODY WRITES NO AUDIT ENTRY, and that is a correction to this
     * feature's own spec (FR-012), made because the tenancy invariant outranks it.**
     *
     * The audit store is account-scoped — every entry lands in one tenant's trail (Principle I). A
     * request for an address in no account has **no tenant**, so recording it would mean guessing one,
     * and a guess puts one tenant's security event in another tenant's trail. That is a worse outcome
     * than not recording it: the isolation invariant is the one this project does not trade.
     *
     * What compensates, so the probing is still bounded and visible: the SOURCE limiter above refuses a
     * walk through a list, and every request for a REAL person is recorded with its reason. The spec is
     * amended by crossing out rather than rewritten.
     */
    if (!sourceOk || !user) {
      await this.spendEqualisingWork();
      return;
    }

    // Per ADDRESS, so nobody may use the form to flood one mailbox. Checked now that a tenant is known,
    // so the refusal is recordable — a refused attempt is still a data point (W9's `contact.lookup`).
    if (
      !this.rate.allow(
        `recovery:addr:${valueHash}`,
        this.cfg.RECOVERY_RATE_MAX,
        this.cfg.RECOVERY_RATE_WINDOW,
      )
    ) {
      await this.record(user.account_id, 'recovery.requested', user.id, 'rate_capped', valueHash);
      return;
    }

    if (!ELIGIBLE_STATUS.has(user.status)) {
      await this.spendEqualisingWork();
      await this.record(user.account_id, 'recovery.requested', user.id, 'inactive', valueHash);
      return;
    }
    const credential = await this.prisma.credential.findFirst({
      where: { user_id: user.id, type: 'password' },
    });
    if (!credential?.secret_hash) {
      // An invited person who never registered. Their route back in is the invitation, not this — and
      // completing recovery would set a password on a registration that never happened.
      await this.spendEqualisingWork();
      await this.record(user.account_id, 'recovery.requested', user.id, 'no_password', valueHash);
      return;
    }

    const secret = randomBytes(32).toString('hex');
    const tokenHash = await this.tokens.hashPassword(secret);
    const expiresAt = new Date(this.clock.now().getTime() + this.cfg.RECOVERY_TTL * 1000);

    // ⭐ The token, the void of any previous one, the outbox row and the audit entry are ONE
    // transaction. A token nobody is ever sent is not a token; it is a row that makes somebody believe
    // a link is coming (feature 028's rule for invitations, and the same reasoning here).
    await this.prisma.$transaction(async (tx) => {
      const client = tx as unknown as {
        recoveryToken: {
          updateMany(a: Record<string, unknown>): Promise<unknown>;
          create(a: Record<string, unknown>): Promise<{ id: string }>;
        };
      };

      // ⚠️ ONE LIVE TOKEN PER PERSON. Asking again kills the previous link — so an old one forwarded
      // out of a mailbox stops working the moment a new one is requested. Voided, never deleted: a dead
      // link must be able to say WHY it is dead.
      await client.recoveryToken.updateMany({
        where: { user_id: user.id, consumed_at: null, voided_at: null },
        data: { voided_at: this.clock.now(), voided_cause: 'superseded' },
      });

      const created = await client.recoveryToken.create({
        data: {
          account_id: user.account_id,
          user_id: user.id,
          token_hash: tokenHash,
          expires_at: expiresAt,
        },
      });

      await this.email.sendRecovery(
        {
          to: address,
          recoveryToken: `${created.id}.${secret}`,
          expiresAt,
          accountId: user.account_id,
        },
        tx as never,
      );
    });

    await this.record(user.account_id, 'recovery.requested', user.id, 'ok', valueHash);
  }

  /**
   * Use the link. Sets a password and issues NOTHING (FR-009).
   *
   * ⚠️ Order: the token's own state first (expiry, consumption, attempts), then eligibility, then the
   * password. A weak password must not consume the link — somebody who mistypes their new password
   * twice would otherwise be locked out by their own typo.
   */
  async complete(rawToken: string, newPassword: string): Promise<CompleteRecoveryOutcome> {
    const parsed = this.parse(rawToken);
    /**
     * ⚠️ A token that parses to nothing, or names an id no row has, writes NO entry — the same tenancy
     * reasoning as an unknown address in `request()`: there is no account to record it against, and
     * guessing one would put a security event in somebody else's trail. Every attempt against a token
     * that EXISTS is recorded, which is where the grind shows up.
     */
    if (!parsed) return { status: 'bad_token' };

    const row = await this.prisma.recoveryToken.findFirst({ where: { id: parsed.id } });
    if (!row) return { status: 'bad_token' };
    if (row.consumed_at) {
      await this.record(row.account_id, 'recovery.refused', row.user_id, 'consumed');
      return { status: 'already_used' };
    }
    if (row.voided_at || row.expires_at.getTime() <= this.clock.now().getTime()) {
      // A superseded token and an expired one are the same thing to the person holding it: gone. The
      // trail keeps the difference.
      await this.record(row.account_id, 'recovery.refused', row.user_id, 'expired');
      return { status: 'expired' };
    }
    if (row.attempts >= this.cfg.RECOVERY_MAX_ATTEMPTS) {
      await this.record(row.account_id, 'recovery.refused', row.user_id, 'attempts');
      return { status: 'bad_token' };
    }

    const secretOk = await this.tokens.verifyPassword(row.token_hash, parsed.secret);
    if (!secretOk) {
      // The counter is on the ROW: a grind against one token kills that token, which a per-address
      // limiter cannot express.
      await this.prisma.recoveryToken.update({
        where: { id: row.id },
        data: { attempts: row.attempts + 1 },
      });
      await this.record(row.account_id, 'recovery.refused', row.user_id, 'bad_secret');
      return { status: 'bad_token' };
    }

    const user = await this.prisma.user.findFirst({ where: { id: row.user_id } });
    if (!user || !ELIGIBLE_STATUS.has(user.status)) {
      await this.record(row.account_id, 'recovery.refused', row.user_id, 'inactive');
      return { status: 'not_eligible' };
    }

    const set = await this.passwords.setPassword({
      accountId: user.account_id,
      userId: user.id,
      newPassword,
      action: 'recovery.completed',
      // The act had no human operator in the CRM sense: whoever held the mailbox did it. Naming the
      // person as the actor would claim they were signed in, which is the one thing they were not.
      actor: { systemRef: 'password-recovery' },
    });

    if (set.status === 'weak') {
      // ⚠️ The token is NOT consumed: a mistyped new password must not cost somebody their only link.
      await this.record(user.account_id, 'recovery.refused', user.id, 'weak_password');
      return { status: 'weak_password', failures: set.failures };
    }
    if (set.status === 'no_credential') {
      await this.record(user.account_id, 'recovery.refused', user.id, 'no_password');
      return { status: 'not_eligible' };
    }

    await this.prisma.recoveryToken.update({
      where: { id: row.id },
      data: { consumed_at: this.clock.now() },
    });
    // ⓘ `recovery.completed` is written by `PasswordService` — the write and its record are one act, and
    // duplicating it here would put two entries in the trail for one password.
    return { status: 'ok', revokedCount: set.revokedCount };
  }

  /**
   * The salted hash of an address. The trail's only expression of WHO was targeted — an investigator
   * confirms «was this address used» by hashing it, and nobody reads an address out of the log (the W9
   * `valueHash` precedent).
   */
  private hashAddress(address: string): string {
    return createHash('sha256').update(`${this.cfg.JWT_SECRET}:${address}`).digest('hex');
  }

  /**
   * ⚠️ The equalising cost, and what it is worth. The known path spends an argon2 hash; this spends one
   * too, so the dominant cost does not depend on whether the address exists. It is NOT a claim of
   * constant time — the remaining difference is a database lookup, and pretending otherwise would be a
   * promise nobody measured.
   */
  private async spendEqualisingWork(): Promise<void> {
    await this.tokens.hashPassword('recovery-equalising-constant');
  }

  private parse(raw: string): { id: string; secret: string } | null {
    const dot = raw.indexOf('.');
    if (dot <= 0 || dot === raw.length - 1) return null;
    return { id: raw.slice(0, dot), secret: raw.slice(dot + 1) };
  }

  /**
   * One entry, in the tenant the subject belongs to.
   *
   * ⚠️ **`accountId` is a parameter and not a lookup**, deliberately: every caller already holds the
   * tenant (from the user row or the token row), and a helper that resolved it would be able to be called
   * without one — which is exactly the case that has no honest answer (see `request()`'s note on an
   * address belonging to nobody).
   *
   * ⚠️ Best-effort is NOT acceptable for this trail (`tests/audit/no-best-effort.spec.ts`), so this throws
   * if it cannot write, and the caller lets it: a recovery nobody can review is worse than one that
   * failed loudly.
   */
  private async record(
    accountId: string,
    action: 'recovery.requested' | 'recovery.refused',
    targetRef: string,
    reasonClass: RecoveryReason,
    valueHash?: string,
  ): Promise<void> {
    await this.audit.append(accountId, {
      action,
      actorUserId: '',
      actorKind: 'system',
      actorRef: 'password-recovery',
      targetRef,
      detail: valueHash ? { reasonClass, valueHash } : { reasonClass },
    });
  }
}
