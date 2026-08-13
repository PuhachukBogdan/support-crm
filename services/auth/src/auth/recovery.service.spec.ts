import { RecoveryService } from './recovery.service';
import type { AuthConfig } from '../config';
import type { PrismaService } from '../prisma.service';
import type { TokenService } from './token.service';
import type { RateLimiter } from './rate-limiter';
import type { AuditRepository } from '../audit/audit.repository';
import type { PasswordService } from './password.service';
import { OutboxEmailAdapter } from './ports/email.port';

/**
 * W36 / feature 041 — the property this whole feature is arranged around: **the answer never varies**,
 * and the link works once.
 *
 * ⚠️ The fake refuses what the database refuses and honours what it honours — the `updateMany` that voids
 * a previous token actually voids it here, because a fake that ignored it would let «one live token per
 * person» pass on a service that never implemented it (`gotchas/a-fake-more-permissive-than-the-library`).
 */

const CFG = {
  JWT_SECRET: 'test-secret',
  RECOVERY_TTL: 1_800,
  RECOVERY_MAX_ATTEMPTS: 3,
  RECOVERY_RATE_MAX: 2,
  RECOVERY_RATE_WINDOW: 3_600,
  RECOVERY_SOURCE_RATE_MAX: 10,
} as unknown as AuthConfig;

const NOW = new Date('2026-08-13T12:00:00.000Z');

interface FakeToken {
  id: string;
  account_id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  attempts: number;
  consumed_at: Date | null;
  voided_at: Date | null;
  voided_cause: string | null;
}

function build(
  opts: {
    user?: { id: string; account_id: string; email: string; status: string } | null;
    hasPassword?: boolean;
    now?: Date;
    setPassword?: 'ok' | 'weak' | 'no_credential';
  } = {},
) {
  const user =
    opts.user === undefined
      ? { id: 'u-1', account_id: 'acc-1', email: 'ann@example.test', status: 'active' }
      : opts.user;
  const tokens: FakeToken[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const email = new OutboxEmailAdapter();
  let seq = 0;
  let hashCalls = 0;
  const clock = { now: () => opts.now ?? NOW };

  const prisma = {
    user: { findFirst: async (a: { where: Record<string, unknown> }) => {
      if (!user) return null;
      if ('email' in a.where) return a.where.email === user.email ? { ...user } : null;
      return a.where.id === user.id ? { ...user } : null;
    } },
    credential: {
      findFirst: async () =>
        (opts.hasPassword ?? true) ? { id: 'cred-1', user_id: 'u-1', secret_hash: 'H' } : null,
    },
    recoveryToken: {
      findFirst: async (a: { where: { id: string } }) => {
        const row = tokens.find((t) => t.id === a.where.id);
        return row ? { ...row } : null;
      },
      update: async (a: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = tokens.find((t) => t.id === a.where.id)!;
        Object.assign(row, a.data);
        return { ...row };
      },
    },
    async $transaction(fn: (tx: unknown) => Promise<unknown>) {
      return fn({
        recoveryToken: {
          updateMany: async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
            for (const t of tokens) {
              if (t.user_id === (a.where as { user_id: string }).user_id && !t.consumed_at && !t.voided_at) {
                Object.assign(t, a.data);
              }
            }
            return { count: 0 };
          },
          create: async (a: { data: Record<string, unknown> }) => {
            seq += 1;
            const row: FakeToken = {
              id: `tok-${seq}`,
              account_id: String(a.data.account_id),
              user_id: String(a.data.user_id),
              token_hash: String(a.data.token_hash),
              expires_at: a.data.expires_at as Date,
              attempts: 0,
              consumed_at: null,
              voided_at: null,
              voided_cause: null,
            };
            tokens.push(row);
            return { id: row.id };
          },
        },
        outboundEmail: { create: async () => ({ id: 'mail-1' }) },
      });
    },
  } as unknown as PrismaService;

  const tokenSvc = {
    hashPassword: async (plain: string) => {
      hashCalls += 1;
      return `HASH(${plain})`;
    },
    verifyPassword: async (hash: string, plain: string) => hash === `HASH(${plain})`,
  } as unknown as TokenService;

  const counters = new Map<string, number>();
  const rate = {
    allow: (key: string, max: number) => {
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return n <= max;
    },
  } as unknown as RateLimiter;

  const passwords = {
    setPassword: async () => {
      const mode = opts.setPassword ?? 'ok';
      if (mode === 'weak') return { status: 'weak', failures: ['digit'] };
      if (mode === 'no_credential') return { status: 'no_credential' };
      return { status: 'ok', revokedCount: 2 };
    },
  } as unknown as PasswordService;

  const audit = {
    append: async (accountId: string, input: Record<string, unknown>) => {
      audits.push({ accountId, ...input });
    },
  } as unknown as AuditRepository;

  const service = new RecoveryService(
    CFG,
    clock,
    prisma,
    tokenSvc,
    rate,
    email,
    passwords,
    audit,
  );
  return { service, tokens, audits, email, hashes: () => hashCalls };
}

/** The clear token as the email carries it. The only place it ever exists in clear. */
const linkToken = (email: OutboxEmailAdapter): string => email.recoveryOutbox.at(-1)!.recoveryToken;

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * The POSITIVE CONTROL first: a link that WORKS. Every refusal below is worthless without it.
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */
describe('⭐ a real address gets a link, and the link sets a password', () => {
  it('queues exactly one mail carrying a token, and the token is not stored in clear', async () => {
    const { service, email, tokens } = build();
    await service.request('ANN@example.test', '203.0.113.7'); // upper case + spaces are normalised

    expect(email.recoveryOutbox).toHaveLength(1);
    expect(tokens).toHaveLength(1);
    const [id, secret] = linkToken(email).split('.');
    expect(id).toBe(tokens[0]!.id);
    /**
     * At rest: the hash, never the token. What this level can honestly assert is that the stored value
     * is the HASHER's output rather than the secret itself.
     *
     * ⚠️ It deliberately does NOT assert «the stored value does not contain the secret» — the fake hasher
     * is `HASH(x)` and literally does, so such an assertion would be testing the double instead of the
     * product. That the real hash reveals nothing is argon2's property and is tested where argon2 is
     * (`token.service.spec.ts`). Asserting a security property against a stand-in is how a suite comes to
     * believe something nothing verified.
     */
    expect(tokens[0]!.token_hash).toBe(`HASH(${secret})`);
    expect(tokens[0]!.token_hash).not.toBe(secret);
    expect(tokens[0]!.token_hash).not.toBe(linkToken(email));
  });

  it('completing it sets the password and reports the sessions it killed', async () => {
    const { service, email } = build();
    await service.request('ann@example.test', 'src');
    await expect(service.complete(linkToken(email), 'New#Passw0rd')).resolves.toEqual({
      status: 'ok',
      revokedCount: 2,
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * FR-001 — the answer never varies. The five cases a requester is not told apart.
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */
describe('*** the request answers IDENTICALLY, and only a real person gets mail ***', () => {
  it.each([
    ['an unknown address', { user: null } as const],
    ['a person who may not sign in', { user: { id: 'u-1', account_id: 'acc-1', email: 'ann@example.test', status: 'disabled' } } as const],
    ['a person with no password yet', { hasPassword: false } as const],
  ])('%s: returns undefined and queues NOTHING', async (_name, opts) => {
    const { service, email, tokens } = build(opts);
    // The rpc has no value to leak — that is the shape of the guarantee, not a convention.
    await expect(service.request('ann@example.test', 'src')).resolves.toBeUndefined();
    expect(email.recoveryOutbox).toHaveLength(0);
    expect(tokens).toHaveLength(0);
  });

  it('⚠️ the argon2 cost is spent EITHER WAY, so the dominant cost does not depend on existence', async () => {
    const known = build();
    await known.service.request('ann@example.test', 'src');
    const unknown = build({ user: null });
    await unknown.service.request('nobody@example.test', 'src');
    // Not a constant-time claim — the remaining difference is a lookup. What is asserted is that the
    // EXPENSIVE step happens on both paths, which is the part an attacker can actually measure.
    expect(unknown.hashes()).toBeGreaterThan(0);
    expect(known.hashes()).toBeGreaterThan(0);
  });

  it('a rate-capped request for a real person is recorded and queues nothing more', async () => {
    const { service, email, audits } = build();
    await service.request('ann@example.test', 'src'); // 1
    await service.request('ann@example.test', 'src'); // 2 — at the cap
    await service.request('ann@example.test', 'src'); // 3 — refused
    expect(email.recoveryOutbox).toHaveLength(2);
    expect(audits.map((a) => (a.detail as { reasonClass: string }).reasonClass)).toEqual([
      'ok',
      'ok',
      'rate_capped',
    ]);
  });

  it('⛔ an unknown address writes NO audit entry — there is no tenant to write it to', async () => {
    // The correction this feature made to its own spec: the trail is account-scoped, and guessing a
    // tenant would file one customer's security event in another's. The source limiter is what bounds
    // the probing instead.
    const { service, audits } = build({ user: null });
    await service.request('nobody@example.test', 'src');
    expect(audits).toHaveLength(0);
  });

  it('every recorded entry carries the salted HASH of the address and never the address', async () => {
    const { service, audits } = build();
    await service.request('ann@example.test', 'src');
    const detail = audits[0]!.detail as { valueHash: string };
    expect(detail.valueHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(audits)).not.toContain('ann@example.test');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════════
 * The token's own life: once, briefly, and not grindable.
 * ════════════════════════════════════════════════════════════════════════════════════════════════ */
describe('*** the link works ONCE ***', () => {
  it('a second use is refused and says «already used»', async () => {
    const { service, email } = build();
    await service.request('ann@example.test', 'src');
    const token = linkToken(email);
    await expect(service.complete(token, 'New#Passw0rd')).resolves.toMatchObject({ status: 'ok' });
    await expect(service.complete(token, 'Other#Passw0rd')).resolves.toEqual({ status: 'already_used' });
  });

  it('asking again VOIDS the previous link — a forwarded old one stops working', async () => {
    const { service, email, tokens } = build();
    await service.request('ann@example.test', 'src');
    const first = linkToken(email);
    await service.request('ann@example.test', 'src');
    expect(tokens[0]!.voided_cause).toBe('superseded');
    // To the holder it is simply gone; the trail keeps the difference between voided and expired.
    await expect(service.complete(first, 'New#Passw0rd')).resolves.toEqual({ status: 'expired' });
    // …and the NEW one still works, so the void was targeted rather than a blanket kill.
    await expect(service.complete(linkToken(email), 'New#Passw0rd')).resolves.toMatchObject({
      status: 'ok',
    });
  });

  it('an expired link is refused', async () => {
    const { service, email } = build();
    await service.request('ann@example.test', 'src');
    const token = linkToken(email);
    const later = build({ now: new Date(NOW.getTime() + 3_600_000) });
    // Re-issue into the later world so the row exists there, then present the token past its TTL.
    await later.service.request('ann@example.test', 'src');
    const stale = new Date(NOW.getTime() - 1);
    later.tokens[0]!.expires_at = stale;
    await expect(later.service.complete(linkToken(later.email), 'New#Passw0rd')).resolves.toEqual({
      status: 'expired',
    });
    expect(token).not.toBe(linkToken(later.email));
  });

  it('wrong secrets are counted ON THE ROW and kill that token', async () => {
    const { service, email, tokens } = build();
    await service.request('ann@example.test', 'src');
    const [id] = linkToken(email).split('.');
    for (let i = 0; i < 3; i += 1) {
      await expect(service.complete(`${id}.wrong`, 'New#Passw0rd')).resolves.toEqual({
        status: 'bad_token',
      });
    }
    expect(tokens[0]!.attempts).toBe(3);
    // At the cap the token is dead — even for the RIGHT secret. A per-address limiter cannot express
    // that, which is why the counter is on the row.
    await expect(service.complete(linkToken(email), 'New#Passw0rd')).resolves.toEqual({
      status: 'bad_token',
    });
  });

  it('an unparseable or unknown token is refused and writes nothing (no tenant to write to)', async () => {
    const { service, audits } = build();
    await expect(service.complete('nonsense', 'New#Passw0rd')).resolves.toEqual({ status: 'bad_token' });
    await expect(service.complete('tok-999.secret', 'New#Passw0rd')).resolves.toEqual({
      status: 'bad_token',
    });
    expect(audits).toHaveLength(0);
  });
});

describe('*** a weak new password does NOT cost the link ***', () => {
  it('is refused, the token stays usable, and the trail says why', async () => {
    const { service, email, tokens, audits } = build({ setPassword: 'weak' });
    await service.request('ann@example.test', 'src');
    const out = await service.complete(linkToken(email), 'weak');
    expect(out).toEqual({ status: 'weak_password', failures: ['digit'] });
    // ⚠️ NOT consumed: somebody who mistypes their new password twice must not be locked out by their
    // own typo.
    expect(tokens[0]!.consumed_at).toBeNull();
    expect(audits.at(-1)).toMatchObject({ action: 'recovery.refused' });
    expect((audits.at(-1)!.detail as { reasonClass: string }).reasonClass).toBe('weak_password');
  });
});

describe('*** the completion writes no entry of its own — the password write owns that ***', () => {
  it('records the request and lets PasswordService record the completion', async () => {
    const { service, email, audits } = build();
    await service.request('ann@example.test', 'src');
    await service.complete(linkToken(email), 'New#Passw0rd');
    // One entry from here (`recovery.requested`). `recovery.completed` belongs to the write, because the
    // write and its record are one act — two entries for one password would be the trail lying.
    expect(audits.map((a) => a.action)).toEqual(['recovery.requested']);
  });
});
