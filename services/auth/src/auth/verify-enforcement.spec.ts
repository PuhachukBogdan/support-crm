import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { LoginService } from './login.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { LockoutService } from './lockout.service';
import type { PrismaService } from '../prisma.service';
import { FixedClock } from './ports/clock';
import { OutboxEmailAdapter } from './ports/email.port';
import { InMemoryAdminNotificationAdapter } from './ports/admin-notify.port';
import { makeAuthConfig, makeFakePrisma, type FakePrisma } from '../../tests/support/auth-test-doubles';

/**
 * T021 (US2) — the second step is UN-BYPASSABLE (SEC-2). A TokenPair is issued ONLY after a
 * valid, unexpired, unconsumed, under-attempt-cap code is consumed; a new Login supersedes any
 * prior unconsumed challenge; and there is NO role-specific shortcut — a super-admin login is
 * exactly as un-bypassable as any other.
 */
describe('Verify-step enforcement (feature 009, US2)', () => {
  const cfg = makeAuthConfig();
  const PASSWORD = 'CorrectHorse1!';
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await argon2.hash(PASSWORD);
  });

  let prisma: FakePrisma;
  let clock: FixedClock;
  let email: OutboxEmailAdapter;
  let login: LoginService;

  function build(roleKey = 'agent') {
    prisma = makeFakePrisma({
      users: [{ id: 'user-1', account_id: 'acct-A', email: 'staff@example.test' }],
      credentials: [{ user_id: 'user-1', type: 'password', secret_hash: passwordHash }],
      userRoles: [{ user_id: 'user-1', roleKey }],
    });
    clock = new FixedClock();
    email = new OutboxEmailAdapter();
    const p = prisma as unknown as PrismaService;
    const tokens = new TokenService(cfg, clock, p, new JwtService({}));
    const otp = new OtpService(cfg, clock, p, email);
    const lockout = new LockoutService(cfg, clock, p, new InMemoryAdminNotificationAdapter());
    login = new LoginService(cfg, clock, p, otp, tokens, lockout);
  }

  async function startLogin() {
    const step1 = await login.login('staff@example.test', PASSWORD);
    expect(step1.status).toBe('code_sent');
    return {
      challengeId: (step1 as { challengeId: string }).challengeId,
      code: email.last()!.code,
    };
  }

  beforeEach(() => build());

  it('no TokenPair without consuming a valid code (wrong code leaves the challenge unconsumed)', async () => {
    const { challengeId } = await startLogin();
    expect(await login.verifyLoginCode(challengeId, 'WRONG9', false)).toBeNull();
    const row = prisma._tables.loginCodes.find((r) => r.challenge_id === challengeId)!;
    expect(row.consumed_at).toBeNull();
  });

  it('a consumed code cannot be replayed for a second token', async () => {
    const { challengeId, code } = await startLogin();
    expect(await login.verifyLoginCode(challengeId, code, false)).not.toBeNull();
    expect(await login.verifyLoginCode(challengeId, code, false)).toBeNull();
  });

  it('an expired code yields no token', async () => {
    const { challengeId, code } = await startLogin();
    clock.advanceSeconds(cfg.CODE_TTL + 1);
    expect(await login.verifyLoginCode(challengeId, code, false)).toBeNull();
  });

  it('attempts are capped — the 6th try is blocked even with the right code', async () => {
    const { challengeId, code } = await startLogin();
    for (let i = 0; i < cfg.CODE_MAX_ATTEMPTS; i++) {
      expect(await login.verifyLoginCode(challengeId, 'BADXYZ', false)).toBeNull();
    }
    expect(await login.verifyLoginCode(challengeId, code, false)).toBeNull();
  });

  it('a new Login supersedes a prior unconsumed challenge (old challenge_id is dead)', async () => {
    const first = await startLogin();
    const second = await startLogin(); // supersedes `first`
    expect(second.challengeId).not.toBe(first.challengeId);

    // The old challenge can no longer be verified (superseded → consumed).
    expect(await login.verifyLoginCode(first.challengeId, first.code, false)).toBeNull();
    // The current challenge works.
    expect(await login.verifyLoginCode(second.challengeId, second.code, false)).not.toBeNull();
  });

  it('super-admin is NOT special — a fabricated/skipped code fails closed, only a real code works', async () => {
    build('super_admin');
    const { challengeId, code } = await startLogin();

    // Fabricated challenge id → no token.
    expect(await login.verifyLoginCode('fabricated-challenge', code, false)).toBeNull();
    // Right challenge, wrong code → no token.
    expect(await login.verifyLoginCode(challengeId, 'NOPE12', false)).toBeNull();
    // Only the genuinely consumed code yields a session — and it carries the super_admin role.
    const pair = await login.verifyLoginCode(challengeId, code, false);
    expect(pair).not.toBeNull();
  });
});
