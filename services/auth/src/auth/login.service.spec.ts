import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { LoginService } from './login.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import type { PrismaService } from '../prisma.service';
import { FixedClock } from './ports/clock';
import { OutboxEmailAdapter } from './ports/email.port';
import { makeAuthConfig, makeFakePrisma, type FakePrisma } from '../../tests/support/auth-test-doubles';

/**
 * T012 (US1) — the two-step login orchestration: correct credentials → CODE_SENT + a code in
 * the outbox (no token yet); wrong password and unknown email are INDISTINGUISHABLE and issue
 * NO code (FR-001, no enumeration); a valid code → a real TokenPair; a locked account → LOCKED.
 */
describe('LoginService (feature 009)', () => {
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
  let tokens: TokenService;

  function build(userOverrides: Record<string, unknown> = {}) {
    prisma = makeFakePrisma({
      users: [{ id: 'user-1', account_id: 'acct-A', email: 'agent@example.test', ...userOverrides }],
      credentials: [{ user_id: 'user-1', type: 'password', secret_hash: passwordHash }],
      userRoles: [{ user_id: 'user-1', roleKey: 'agent' }],
    });
    clock = new FixedClock();
    email = new OutboxEmailAdapter();
    const p = prisma as unknown as PrismaService;
    tokens = new TokenService(cfg, clock, p, new JwtService({}));
    const otp = new OtpService(cfg, clock, p, email);
    login = new LoginService(cfg, clock, p, otp, tokens);
  }

  beforeEach(() => build());

  it('correct email + password → CODE_SENT with a code delivered to the outbox (no token)', async () => {
    const outcome = await login.login('agent@example.test', PASSWORD);
    expect(outcome.status).toBe('code_sent');
    expect(email.outbox).toHaveLength(1);
    expect(email.last()!.to).toBe('agent@example.test');
    // A token is NEVER part of step 1.
    expect(JSON.stringify(outcome)).not.toContain('accessToken');
  });

  it('wrong password → invalid_credentials and NO code issued', async () => {
    const outcome = await login.login('agent@example.test', 'WrongPassword9!');
    expect(outcome.status).toBe('invalid_credentials');
    expect(email.outbox).toHaveLength(0);
  });

  it('unknown email → invalid_credentials, indistinguishable from a wrong password, no code', async () => {
    const outcome = await login.login('ghost@example.test', PASSWORD);
    expect(outcome.status).toBe('invalid_credentials');
    expect(email.outbox).toHaveLength(0);
  });

  it('runs a password verify even for an unknown email (no timing oracle — SC-006)', async () => {
    // Access the TokenService the LoginService was built with and spy on its verify.
    const spy = jest.spyOn(tokens, 'verifyPassword');
    await login.login('ghost@example.test', PASSWORD);
    expect(spy).toHaveBeenCalled(); // a hash comparison happened despite no such account
  });

  it('a valid code → a TokenPair whose access token is account-bound', async () => {
    const step1 = await login.login('agent@example.test', PASSWORD);
    expect(step1.status).toBe('code_sent');
    const code = email.last()!.code;
    const challengeId = (step1 as { challengeId: string }).challengeId;

    const pair = await login.verifyLoginCode(challengeId, code, false);
    expect(pair).not.toBeNull();
    expect(pair!.accessToken).toBeTruthy();
    expect(pair!.refreshToken).toMatch(/^rt-\d+\./);

    const claims = tokens.verifyAccessToken(pair!.accessToken);
    expect(claims.valid).toBe(true);
    expect(claims.accountId).toBe('acct-A');
    expect(claims.roles).toEqual(['agent']);
  });

  it('a wrong code at step 2 yields no token', async () => {
    const step1 = await login.login('agent@example.test', PASSWORD);
    const challengeId = (step1 as { challengeId: string }).challengeId;
    const pair = await login.verifyLoginCode(challengeId, 'WRONG9', false);
    expect(pair).toBeNull();
  });

  it('a locked account → LOCKED (login refused before any code)', async () => {
    build({ locked_until: new Date(Date.now() + 60_000) });
    const outcome = await login.login('agent@example.test', PASSWORD);
    expect(outcome.status).toBe('locked');
    expect(email.outbox).toHaveLength(0);
  });
});
