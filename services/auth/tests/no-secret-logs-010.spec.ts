import { JwtService } from '@nestjs/jwt';
import { OnboardingService } from '../src/auth/onboarding.service';
import { InviteService, type Inviter } from '../src/auth/invite.service';
import { RegistrationService } from '../src/auth/registration.service';
import { OtpService } from '../src/auth/otp.service';
import { TokenService } from '../src/auth/token.service';
import { RateLimiter } from '../src/auth/rate-limiter';
import type { PrismaService } from '../src/prisma.service';
import { FixedClock } from '../src/auth/ports/clock';
import { OutboxEmailAdapter } from '../src/auth/ports/email.port';
import { makeAuthConfig, makeFakePrisma } from './support/auth-test-doubles';

/**
 * T029 (feature 010, Polish) — the account-lifecycle flows never log a secret (FR-016 / SC-006).
 * Runs activation + invite + registration while capturing ALL console output and asserts no
 * password, one-time code, invite-token secret, or session token ever appears.
 */
describe('account-lifecycle flows never log secrets (FR-016 / SC-006)', () => {
  const cfg = makeAuthConfig();
  const SA_PW = 'SuperPass1!';
  const REG_PW = 'InvitedPass9!';

  it('captures activation/invite/registration output and finds no secret', async () => {
    const prisma = makeFakePrisma({
      whitelist: [{ email: 'god@example.test', account_id: 'acct-A' }],
      users: [{ id: 'sa-boot', account_id: 'acct-A', email: 'admin-boot@example.test', status: 'active' }],
      userRoles: [{ user_id: 'sa-boot', roleKey: 'super_admin' }],
    });
    // Feature 011: invites require the target role to exist in the account catalogue (acct-A here).
    prisma._tables.roles.push({ id: 'role-manager', account_id: 'acct-A', key: 'manager' });
    const clock = new FixedClock();
    const email = new OutboxEmailAdapter();
    const p = prisma as unknown as PrismaService;
    const tokens = new TokenService(cfg, clock, p, new JwtService({}));
    const otp = new OtpService(cfg, clock, p, email);
    const rate = new RateLimiter(clock);
    const onboarding = new OnboardingService(cfg, clock, p, otp, tokens, rate);
    const invites = new InviteService(cfg, clock, p, tokens, rate, email);
    const registration = new RegistrationService(cfg, clock, p, otp, tokens);
    const inviter: Inviter = { userId: 'sa-boot', accountId: 'acct-A', roles: ['super_admin'] };

    const sinks = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const captured: string[] = [];
    const spies = sinks.map((s) =>
      jest.spyOn(console, s).mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(' '));
      }),
    );

    let activationCode: string;
    let inviteToken: string;
    let regCode: string;
    let saTokens: { accessToken: string; refreshToken: string };
    let regTokens: { accessToken: string; refreshToken: string };
    try {
      // Activation.
      await onboarding.requestActivation('god@example.test');
      activationCode = email.last()!.code;
      const act = await onboarding.completeActivation('god@example.test', activationCode, SA_PW);
      if (act.status !== 'ok') throw new Error('activation failed');
      saTokens = act.pair;

      // Invite + registration.
      await invites.createInvitation(inviter, 'invitee@example.test', 'manager');
      inviteToken = email.inviteOutbox[email.inviteOutbox.length - 1]!.inviteToken;
      await registration.startRegistration(inviteToken, 'invitee@example.test');
      regCode = email.last()!.code;
      const reg = await registration.completeRegistration(inviteToken, 'invitee@example.test', regCode, REG_PW);
      if (reg.status !== 'ok') throw new Error('registration failed');
      regTokens = reg.pair;
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    const haystack = captured.join('\n');
    const secrets = [
      SA_PW,
      REG_PW,
      activationCode!,
      regCode!,
      inviteToken!,
      inviteToken!.split('.')[1]!, // the raw invite secret half
      saTokens!.accessToken,
      saTokens!.refreshToken,
      regTokens!.accessToken,
      regTokens!.refreshToken,
    ];
    for (const secret of secrets) {
      expect(haystack).not.toContain(secret);
    }
  });
});
