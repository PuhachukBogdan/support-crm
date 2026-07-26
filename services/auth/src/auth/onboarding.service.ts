import { Inject, Injectable } from '@nestjs/common';
import { AUTH_CONFIG, type AuthConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { CLOCK, type Clock } from './ports/clock';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { RateLimiter } from './rate-limiter';
import { validatePassword, policyFromConfig, type PasswordFailure } from './password-policy';
import type { IssuedTokenPair } from './login.service';

/** Step-2 outcome for super-admin activation. */
export type ActivationOutcome =
  | { status: 'ok'; pair: IssuedTokenPair }
  | { status: 'invalid' }
  | { status: 'weak_password'; failures: PasswordFailure[] };

const SUPER_ADMIN_ROLE = 'super_admin';

/**
 * OnboardingService (feature 010, roadmap 3.8). Super-admins appear ONLY from the server-side
 * `SuperadminWhitelist` (edited out-of-band). The entry point is generic + anti-enumeration
 * (FR-002a): `requestActivation` returns nothing distinguishing and emails a one-time code ONLY
 * when the email is whitelisted and has no active account. `completeActivation` verifies the code
 * + the set-time password policy (U1) and, only then, creates the ACTIVE super-admin (bound to the
 * whitelist entry's account — R2) and issues a session (a valid code was consumed — SEC-2 spirit).
 *
 * The whitelist/user lookups are the pre-account **bootstrap** path (research R7 / N2): they use
 * the RAW client (they *resolve* the account); every write is account-bound.
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(RateLimiter) private readonly rate: RateLimiter,
  ) {}

  /** Generic entry: identical outcome for any email; a code is emailed only if eligible. */
  async requestActivation(email: string): Promise<void> {
    // Throttle repeated activation requests per email (FR-020/U1); a throttled call is
    // indistinguishable from an ineligible one (still equalized, still a uniform ack).
    if (
      !this.rate.allow(
        `activate:${email}`,
        this.cfg.ONBOARD_REQUEST_RATE_MAX,
        this.cfg.ONBOARD_REQUEST_RATE_WINDOW,
      )
    ) {
      await this.equalizeCost();
      return;
    }

    const entry = await this.prisma.superadminWhitelist.findUnique({ where: { email } });
    const user = await this.prisma.user.findFirst({ where: { email } });
    const eligible = !!entry && (!user || user.status !== 'active');
    if (!entry || !eligible) {
      // Equalize cost so a non-whitelisted / already-active email is timing-indistinguishable
      // from an eligible one (no enumeration — FR-002a/SC-006).
      await this.equalizeCost();
      return;
    }

    let subject = user;
    if (!subject) {
      subject = await this.prisma.user.create({
        data: { account_id: entry.account_id, email, status: 'pending' },
      });
      await this.assignRole(subject.id, subject.account_id, SUPER_ADMIN_ROLE);
    }

    await this.otp.issueChallenge(
      { id: subject.id, account_id: subject.account_id, email: subject.email },
      'activation',
    );
  }

  /** Finish activation: verify code + password policy → active super-admin + session. */
  async completeActivation(
    email: string,
    code: string,
    password: string,
  ): Promise<ActivationOutcome> {
    const check = validatePassword(password, policyFromConfig(this.cfg));
    if (!check.ok) return { status: 'weak_password', failures: check.failures };

    const entry = await this.prisma.superadminWhitelist.findUnique({ where: { email } });
    const user = await this.prisma.user.findFirst({ where: { email } });
    if (!entry || !user || user.status === 'active') return { status: 'invalid' };

    const result = await this.otp.verifyCodeForUser(user.id, code, 'activation');
    if (!result.ok) return { status: 'invalid' };

    await this.setPassword(user.id, user.account_id, password);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { status: 'active', failed_login_count: 0, locked_until: null },
    });

    const roles = await this.loadRoles(user.id);
    const access = this.tokens.signAccessToken({
      userId: user.id,
      accountId: user.account_id,
      roles,
    });
    const refresh = await this.tokens.issueRefresh(user.id, user.account_id, false);
    return {
      status: 'ok',
      pair: {
        accessToken: access.token,
        refreshToken: refresh.refreshToken,
        accessExpiresAt: access.expiresAt,
        refreshExpiresAt: refresh.expiresAt,
      },
    };
  }

  private async setPassword(userId: string, accountId: string, password: string): Promise<void> {
    const hash = await this.tokens.hashPassword(password);
    const existing = await this.prisma.credential.findFirst({
      where: { user_id: userId, type: 'password' },
    });
    if (existing) {
      await this.prisma.credential.update({ where: { id: existing.id }, data: { secret_hash: hash } });
    } else {
      await this.prisma.credential.create({
        data: { account_id: accountId, user_id: userId, type: 'password', secret_hash: hash },
      });
    }
  }

  private async assignRole(userId: string, accountId: string, key: string): Promise<void> {
    const role = await this.prisma.role.upsert({
      where: { account_id_key: { account_id: accountId, key } },
      create: { account_id: accountId, key },
      update: {},
    });
    await this.prisma.userRole.create({ data: { user_id: userId, role_id: role.id } });
  }

  private async loadRoles(userId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { user_id: userId },
      include: { role: true },
    });
    return rows.map((r) => r.role.key);
  }

  private dummyHashCache?: string;
  private async equalizeCost(): Promise<void> {
    if (!this.dummyHashCache) {
      this.dummyHashCache = await this.tokens.hashPassword('onboarding-equalize-placeholder');
    }
    // One hash of equivalent cost so eligible vs ineligible paths take similar time.
    await this.tokens.verifyPassword(this.dummyHashCache, 'onboarding-equalize-check');
  }
}
