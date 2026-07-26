import { Inject, Injectable } from '@nestjs/common';
import { AUTH_CONFIG, type AuthConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { CLOCK, type Clock } from './ports/clock';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { validatePassword, policyFromConfig, type PasswordFailure } from './password-policy';
import type { IssuedTokenPair } from './login.service';

export type RegistrationStartOutcome =
  | { status: 'code_sent'; codeExpiresAt: number }
  | { status: 'invalid' };

export type RegistrationCompleteOutcome =
  | { status: 'ok'; pair: IssuedTokenPair }
  | { status: 'invalid' }
  | { status: 'weak_password'; failures: PasswordFailure[] };

/**
 * RegistrationService (feature 010, roadmap 3.10). An invited person redeems the single-use invite
 * link, proves live control of the address via a fresh emailed code (009 OTP, purpose="registration"),
 * and sets a policy-compliant password. Registration requires BOTH artifacts (research R3). On
 * success the pre-created `invited` user flips to `active` with its assigned role, the invite is
 * consumed, and a session is issued.
 *
 * The invite lookup-by-token is a pre-account bootstrap read via the RAW client (N2).
 */
@Injectable()
export class RegistrationService {
  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(TokenService) private readonly tokens: TokenService,
  ) {}

  async startRegistration(inviteToken: string, email: string): Promise<RegistrationStartOutcome> {
    const inv = await this.resolveInvite(inviteToken, email);
    if (!inv) return { status: 'invalid' };

    const user = await this.prisma.user.findFirst({ where: { email } });
    if (!user || user.status === 'active' || user.status === 'disabled') return { status: 'invalid' };

    const challenge = await this.otp.issueChallenge(
      { id: user.id, account_id: user.account_id, email: user.email },
      'registration',
    );
    return { status: 'code_sent', codeExpiresAt: challenge.codeExpiresAt };
  }

  async completeRegistration(
    inviteToken: string,
    email: string,
    code: string,
    password: string,
  ): Promise<RegistrationCompleteOutcome> {
    const check = validatePassword(password, policyFromConfig(this.cfg));
    if (!check.ok) return { status: 'weak_password', failures: check.failures };

    const inv = await this.resolveInvite(inviteToken, email);
    if (!inv) return { status: 'invalid' };

    const user = await this.prisma.user.findFirst({ where: { email } });
    if (!user || user.status === 'active' || user.status === 'disabled') return { status: 'invalid' };

    const result = await this.otp.verifyCodeForUser(user.id, code, 'registration');
    if (!result.ok) return { status: 'invalid' };

    await this.setPassword(user.id, user.account_id, password);
    await this.prisma.user.update({ where: { id: user.id }, data: { status: 'active' } });
    // Single-use: consume the invite so it can never be redeemed again.
    await this.prisma.invitation.update({
      where: { id: inv.id },
      data: { consumed_at: this.clock.now() },
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

  /** Validate the invite token (id+secret), unconsumed, unexpired, and email match. RAW read (N2). */
  private async resolveInvite(inviteToken: string, email: string) {
    const parsed = this.parse(inviteToken);
    if (!parsed) return null;
    const inv = await this.prisma.invitation.findUnique({ where: { id: parsed.id } });
    if (!inv || inv.consumed_at) return null;
    if (inv.expires_at.getTime() <= this.clock.now().getTime()) return null;
    if (inv.email !== email) return null;
    const ok = await this.tokens.verifyPassword(inv.token_hash, parsed.secret);
    if (!ok) return null;
    return inv;
  }

  private parse(raw: string): { id: string; secret: string } | null {
    const dot = raw.indexOf('.');
    if (dot <= 0 || dot === raw.length - 1) return null;
    return { id: raw.slice(0, dot), secret: raw.slice(dot + 1) };
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

  private async loadRoles(userId: string): Promise<string[]> {
    const rows = await this.prisma.userRole.findMany({
      where: { user_id: userId },
      include: { role: true },
    });
    return rows.map((r) => r.role.key);
  }
}
