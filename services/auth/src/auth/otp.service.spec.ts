import { OtpService } from './otp.service';
import type { PrismaService } from '../prisma.service';
import { FixedClock } from './ports/clock';
import { OutboxEmailAdapter } from './ports/email.port';
import { makeAuthConfig, makeFakePrisma, type FakePrisma } from '../../tests/support/auth-test-doubles';

/**
 * T012 (US1) — the one-time code is generated, hashed (never stored clear), delivered to the
 * outbox, and verified with single-use + expiry + attempt-cap semantics against the FixedClock.
 */
describe('OtpService (feature 009)', () => {
  const cfg = makeAuthConfig();
  const subject = { id: 'user-1', account_id: 'acct-A', email: 'agent@example.test' };
  let prisma: FakePrisma;
  let clock: FixedClock;
  let email: OutboxEmailAdapter;
  let otp: OtpService;

  beforeEach(() => {
    prisma = makeFakePrisma();
    clock = new FixedClock();
    email = new OutboxEmailAdapter();
    otp = new OtpService(cfg, clock, prisma as unknown as PrismaService, email);
  });

  it('issues a challenge, emails a code, and stores only the hash', async () => {
    const { challengeId } = await otp.issueChallenge(subject);
    expect(challengeId).toBeTruthy();
    const sent = email.last()!;
    expect(sent.to).toBe(subject.email);
    expect(sent.code).toHaveLength(cfg.CODE_LENGTH);
    const row = prisma._tables.loginCodes.find((r) => r.challenge_id === challengeId)!;
    expect(row.code_hash).not.toBe(sent.code);
    expect(row.code_hash.startsWith('$argon2')).toBe(true);
    expect(row.account_id).toBe('acct-A');
  });

  it('verifies the correct code once and resolves the identity', async () => {
    const { challengeId } = await otp.issueChallenge(subject);
    const code = email.last()!.code;
    const result = await otp.verifyCode(challengeId, code);
    expect(result).toEqual({ ok: true, userId: 'user-1', accountId: 'acct-A' });
  });

  it('refuses a replay of a consumed code (single-use)', async () => {
    const { challengeId } = await otp.issueChallenge(subject);
    const code = email.last()!.code;
    await otp.verifyCode(challengeId, code);
    const replay = await otp.verifyCode(challengeId, code);
    expect(replay).toEqual({ ok: false, reason: 'consumed' });
  });

  it('refuses a wrong code and caps attempts at CODE_MAX_ATTEMPTS', async () => {
    const { challengeId } = await otp.issueChallenge(subject);
    for (let i = 0; i < cfg.CODE_MAX_ATTEMPTS; i++) {
      expect(await otp.verifyCode(challengeId, 'WRONG9')).toEqual({ ok: false, reason: 'invalid' });
    }
    // The (max+1)-th attempt is blocked even if the code were right.
    const code = email.last()!.code;
    expect(await otp.verifyCode(challengeId, code)).toEqual({ ok: false, reason: 'exhausted' });
  });

  it('refuses an expired code (clock advanced past CODE_TTL)', async () => {
    const { challengeId } = await otp.issueChallenge(subject);
    const code = email.last()!.code;
    clock.advanceSeconds(cfg.CODE_TTL + 1);
    expect(await otp.verifyCode(challengeId, code)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses an unknown challenge', async () => {
    expect(await otp.verifyCode('no-such-challenge', 'ABC123')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
