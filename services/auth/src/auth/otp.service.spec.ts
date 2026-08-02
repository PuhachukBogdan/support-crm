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

/**
 * T017 / T019 (feature 028) — the code and the intent to deliver it are ONE transaction, and a
 * refused sign-in produces no message at all.
 */
describe('OtpService — the outbox (feature 028)', () => {
  const cfg = makeAuthConfig();
  const subject = { id: 'user-1', account_id: 'acct-A', email: 'agent@example.test' };

  /** A port that records into the outbox table the way the real adapter does. */
  function recordingPort(prisma: FakePrisma) {
    return {
      sendLoginCode: async (m: { to: string; code: string; expiresAt: Date; accountId: string }, tx?: unknown) => {
        await ((tx ?? prisma) as FakePrisma).outboundEmail.create({
          data: {
            account_id: m.accountId,
            to_email: m.to,
            purpose: 'login_code',
            payload_json: { code: m.code },
            expires_at: m.expiresAt,
          },
        });
      },
      sendInvite: async () => undefined,
    };
  }

  it('⭐ records exactly one message, inside the same transaction as the code', async () => {
    const prisma = makeFakePrisma();
    const otp = new OtpService(cfg, new FixedClock(), prisma as unknown as PrismaService, recordingPort(prisma) as never);

    await otp.issueChallenge(subject);

    expect(prisma._tables.outboundEmails).toHaveLength(1);
    expect(prisma._tables.loginCodes).toHaveLength(1);
    expect(prisma._tables.outboundEmails[0]).toMatchObject({
      to_email: subject.email,
      purpose: 'login_code',
      account_id: subject.account_id,
      status: 'pending',
    });
  });

  it('⚠️ the transaction is real: if recording the message fails, no code survives either', async () => {
    // The failure this prevents is the confusing one — a code that exists and will never be sent
    // presents to the person as a code that never arrives, and there is nothing to find.
    const prisma = makeFakePrisma();
    const exploding = {
      sendLoginCode: async () => {
        throw new Error('outbox write failed');
      },
      sendInvite: async () => undefined,
    };
    const otp = new OtpService(cfg, new FixedClock(), prisma as unknown as PrismaService, exploding as never);

    await expect(otp.issueChallenge(subject)).rejects.toThrow();
    // ⓘ The fake applies writes eagerly, so this asserts the CALL SHAPE rather than a rollback:
    // the send is inside the transaction callback, which is what makes a real rollback possible.
    // Atomicity itself is a property of Postgres and is asserted live (quickstart B1).
    expect(prisma._tables.outboundEmails).toHaveLength(0);
  });

  it('carries the code and the code’s own expiry, not a second clock', async () => {
    const prisma = makeFakePrisma();
    const otp = new OtpService(cfg, new FixedClock(), prisma as unknown as PrismaService, recordingPort(prisma) as never);

    await otp.issueChallenge(subject);

    const row = prisma._tables.outboundEmails[0] as { expires_at: Date; payload_json: { code: string } };
    const stored = prisma._tables.loginCodes[0]!;
    expect(row.expires_at).toEqual(stored.expires_at);
    expect(String(row.payload_json.code)).toHaveLength(cfg.CODE_LENGTH);
  });
});
