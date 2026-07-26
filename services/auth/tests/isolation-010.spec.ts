import { JwtService } from '@nestjs/jwt';
import { OnboardingService } from '../src/auth/onboarding.service';
import { InviteService, type Inviter } from '../src/auth/invite.service';
import { OtpService } from '../src/auth/otp.service';
import { TokenService } from '../src/auth/token.service';
import { RateLimiter } from '../src/auth/rate-limiter';
import type { PrismaService } from '../src/prisma.service';
import { FixedClock } from '../src/auth/ports/clock';
import { OutboxEmailAdapter } from '../src/auth/ports/email.port';
import { makeAuthConfig, makeFakePrisma } from './support/auth-test-doubles';

/**
 * T030 (feature 010, Polish) — account isolation (Principle I / FR-018). Everything the lifecycle
 * flows create for account A is bound to A; nothing lands in another account, and the minted
 * access token carries account A. The pre-account bootstrap reads *resolve* the account, they
 * never cross it.
 */
describe('account-lifecycle isolation (Principle I / FR-018)', () => {
  const cfg = makeAuthConfig();

  it('activation + invite for account A create only account-A rows and account-A tokens', async () => {
    const prisma = makeFakePrisma({
      whitelist: [{ email: 'god@acct-a.test', account_id: 'acct-A' }],
      // A pre-existing super-admin in a DIFFERENT account, to prove nothing leaks across.
      users: [{ id: 'sa-b', account_id: 'acct-B', email: 'god@acct-b.test', status: 'active' }],
      userRoles: [{ user_id: 'sa-b', roleKey: 'super_admin' }],
    });
    const clock = new FixedClock();
    const email = new OutboxEmailAdapter();
    const p = prisma as unknown as PrismaService;
    const tokens = new TokenService(cfg, clock, p, new JwtService({}));
    const otp = new OtpService(cfg, clock, p, email);
    const rate = new RateLimiter(clock);
    const onboarding = new OnboardingService(cfg, clock, p, otp, tokens, rate);
    const invites = new InviteService(cfg, clock, p, tokens, rate, email);
    const inviterA: Inviter = { userId: 'god-a', accountId: 'acct-A', roles: ['super_admin'] };

    // Activate the account-A super-admin.
    await onboarding.requestActivation('god@acct-a.test');
    const act = await onboarding.completeActivation('god@acct-a.test', email.last()!.code, 'Passw0rd!');
    expect(act.status).toBe('ok');
    if (act.status !== 'ok') throw new Error('unreachable');

    // Issue an account-A invite.
    await invites.createInvitation(inviterA, 'invitee@acct-a.test', 'manager');

    // Every row created by the flows is bound to account A (the seeded acct-B rows are untouched).
    const created = [
      ...prisma._tables.users.filter((u) => u.id !== 'sa-b'),
      ...prisma._tables.credentials,
      ...prisma._tables.loginCodes,
      ...prisma._tables.refreshTokens,
      ...prisma._tables.invitations,
      ...prisma._tables.whitelist,
    ];
    for (const row of created) {
      expect(row.account_id).toBe('acct-A');
    }
    // Nothing the flows wrote landed in account B.
    expect(prisma._tables.invitations.some((i) => i.account_id === 'acct-B')).toBe(false);
    expect(prisma._tables.credentials.some((c) => c.account_id === 'acct-B')).toBe(false);

    // The minted access token is account-A bound.
    const claims = tokens.verifyAccessToken(act.pair.accessToken);
    expect(claims.valid).toBe(true);
    expect(claims.accountId).toBe('acct-A');
  });
});
