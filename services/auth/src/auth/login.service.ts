import { Inject, Injectable } from '@nestjs/common';
import { AUTH_CONFIG, type AuthConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { CLOCK, type Clock } from './ports/clock';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { LockoutService } from './lockout.service';

/** Step-1 outcome (domain vocabulary; the gRPC controller maps it to proto `LoginStatus`). */
export type LoginOutcome =
  | { status: 'code_sent'; challengeId: string; codeExpiresAt: number }
  | { status: 'invalid_credentials' }
  | { status: 'locked' };

/** Step-2 result: a full token pair, or null when the code step failed. */
export interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
  refreshExpiresAt: number;
}

/**
 * LoginService (feature 009, T017). Orchestrates the two-step login:
 *  step 1 — resolve the user by email (the pre-account bootstrap; NOT account-scoped — R7),
 *           verify the argon2 password, and on success issue a one-time code (OtpService).
 *           Unknown email and wrong password are indistinguishable (`invalid_credentials`,
 *           no code issued — FR-001, no enumeration).
 *  step 2 — verify the code and, only then, mint the access token + rotating refresh (TokenService).
 *
 * A token is NEVER produced in step 1 — there is no credential-only path to a session
 * (Principle II / SEC-2). Lockout counting + admin-notify are added in US4.
 */
@Injectable()
export class LoginService {
  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(LockoutService) private readonly lockout: LockoutService,
  ) {}

  async login(email: string, password: string): Promise<LoginOutcome> {
    // Pre-account lookup (research R7): the raw client is the audited bootstrap path — it
    // *establishes* account_id, so it is intentionally not withAccountScope-wrapped.
    const user = await this.prisma.user.findFirst({ where: { email } });
    if (!user || user.status !== 'active') {
      // Equalise cost so an unknown email is timing-indistinguishable from a wrong password
      // (no enumeration — FR-001 / SC-006).
      await this.equalizeVerifyCost(password);
      return { status: 'invalid_credentials' };
    }

    if (this.lockout.isLocked(user)) {
      return { status: 'locked' };
    }

    const credential = await this.prisma.credential.findFirst({
      where: { user_id: user.id, type: 'password' },
    });
    if (!credential?.secret_hash) {
      await this.equalizeVerifyCost(password);
      return { status: 'invalid_credentials' };
    }

    const ok = await this.tokens.verifyPassword(credential.secret_hash, password);
    if (!ok) {
      // Consecutive failures count toward lockout (SEC-14); at the threshold the account locks
      // and an admin is notified (identity only). The response stays generic either way.
      const nowLocked = await this.lockout.recordFailure(user);
      return { status: nowLocked ? 'locked' : 'invalid_credentials' };
    }

    const challenge = await this.otp.issueChallenge({
      id: user.id,
      account_id: user.account_id,
      email: user.email,
    });
    return { status: 'code_sent', ...challenge };
  }

  async verifyLoginCode(
    challengeId: string,
    code: string,
    rememberMe: boolean,
  ): Promise<IssuedTokenPair | null> {
    const result = await this.otp.verifyCode(challengeId, code);
    if (!result.ok) return null;

    const roles = await this.loadRoles(result.userId);

    // Successful login clears any accumulated failure state.
    await this.lockout.reset(result.userId);

    const access = this.tokens.signAccessToken({
      userId: result.userId,
      accountId: result.accountId,
      roles,
    });
    const refresh = await this.tokens.issueRefresh(result.userId, result.accountId, rememberMe);

    return {
      accessToken: access.token,
      refreshToken: refresh.refreshToken,
      accessExpiresAt: access.expiresAt,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  // A throwaway argon2 hash (computed once, cached) so the no-such-user / no-password paths
  // still pay one verify — keeping login time constant regardless of whether the account exists.
  private dummyHashCache?: string;
  private async equalizeVerifyCost(password: string): Promise<void> {
    if (!this.dummyHashCache) {
      this.dummyHashCache = await this.tokens.hashPassword('nonexistent-account-placeholder');
    }
    await this.tokens.verifyPassword(this.dummyHashCache, password);
  }

  private async loadRoles(userId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { user_id: userId },
      include: { role: true },
    });
    return rows.map((r) => r.role.key);
  }
}
