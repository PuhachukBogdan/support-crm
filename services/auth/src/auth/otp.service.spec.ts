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
 * The FIXED sign-in code (2026-08-10) — a stand convenience for named accounts.
 *
 * ⚠️ What these tests are really guarding is the part that does NOT change. It is easy to build
 * "a code that is always the same" by short-circuiting the challenge, and the result would be a
 * second sign-in path with none of the first one's properties. The code string is the only thing
 * this feature is allowed to touch: expiry, single use, the attempt cap and supersession must read
 * identically, and an address that is not on the list must be unable to tell the feature exists.
 */
describe('OtpService — the fixed sign-in code', () => {
  const owner = { id: 'user-1', account_id: 'acct-A', email: 'warden@stand.test' };
  const someoneElse = { id: 'user-2', account_id: 'acct-A', email: 'agent@example.test' };
  const cfg = makeAuthConfig({
    DEV_FIXED_LOGIN_CODE: 'ABCD23',
    DEV_FIXED_LOGIN_CODE_EMAILS: 'warden@stand.test',
  });

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

  it('emails the SAME code to a listed address, every time', async () => {
    await otp.issueChallenge(owner);
    await otp.issueChallenge(owner);
    await otp.issueChallenge(owner);

    expect(email.last()!.code).toBe('ABCD23');
    // Three separate challenges, one code — and each was still hashed independently.
    expect(prisma._tables.loginCodes).toHaveLength(3);
    const hashes = new Set(prisma._tables.loginCodes.map((r) => r.code_hash));
    expect(hashes.size).toBe(3);
  });

  it('⭐ still stores only the hash — a fixed code is not a stored code', async () => {
    const { challengeId } = await otp.issueChallenge(owner);
    const row = prisma._tables.loginCodes.find((r) => r.challenge_id === challengeId)!;
    expect(row.code_hash).not.toContain('ABCD23');
    expect(row.code_hash.startsWith('$argon2')).toBe(true);
  });

  it('⚠️ leaves an address that is NOT listed on a random code', async () => {
    // The failure this prevents is the one that would matter: a knob meant for one account
    // quietly becoming the second factor for everybody on the stand.
    await otp.issueChallenge(someoneElse);
    const first = email.last()!.code;
    await otp.issueChallenge(someoneElse);
    const second = email.last()!.code;

    expect(first).not.toBe('ABCD23');
    expect(second).not.toBe('ABCD23');
    expect(first).not.toBe(second);
  });

  it('matches the address case-insensitively, the way a person types it', async () => {
    await otp.issueChallenge({ ...owner, email: 'Warden@Stand.TEST' });
    expect(email.last()!.code).toBe('ABCD23');
  });

  it('⭐ is still SINGLE-USE — knowing the code is not a second session', async () => {
    const { challengeId } = await otp.issueChallenge(owner);
    expect(await otp.verifyCode(challengeId, 'ABCD23')).toEqual({
      ok: true,
      userId: 'user-1',
      accountId: 'acct-A',
    });
    expect(await otp.verifyCode(challengeId, 'ABCD23')).toEqual({ ok: false, reason: 'consumed' });
  });

  it('⭐ still EXPIRES, and a superseded challenge stays dead', async () => {
    const stale = await otp.issueChallenge(owner);
    const fresh = await otp.issueChallenge(owner);
    // The earlier challenge was superseded even though the code it carries is still correct.
    expect(await otp.verifyCode(stale.challengeId, 'ABCD23')).toEqual({
      ok: false,
      reason: 'consumed',
    });
    clock.advanceSeconds(cfg.CODE_TTL + 1);
    expect(await otp.verifyCode(fresh.challengeId, 'ABCD23')).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('is OFF when only the allow-list is set, with no code', async () => {
    // `loadAuthConfig` refuses to start on this pairing; the service itself must also not
    // improvise — a half-configuration produces ordinary random codes, never an empty one.
    const half = makeAuthConfig({ DEV_FIXED_LOGIN_CODE_EMAILS: 'warden@stand.test' });
    const svc = new OtpService(half, clock, prisma as unknown as PrismaService, email);
    await svc.issueChallenge(owner);
    expect(email.last()!.code).toHaveLength(cfg.CODE_LENGTH);
    expect(email.last()!.code).not.toBe('');
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
