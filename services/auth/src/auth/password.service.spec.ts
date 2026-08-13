import { PasswordService, type SetPasswordInput } from './password.service';
import type { AuthConfig } from '../config';
import type { PrismaService } from '../prisma.service';
import type { TokenService } from './token.service';
import type { RefreshService } from './refresh.service';
import type { AuditRepository } from '../audit/audit.repository';

/**
 * W36 / feature 041 — **the one write**, and the four things it must always do together: enforce the
 * policy, replace the ONE hash, move `last_rotated_at`, and kill every renewable session — with exactly
 * one entry in the trail and nothing secret in it.
 *
 * ⚠️ The fake refuses what the database refuses. `credential.findFirst` answers ONE row because
 * `@@unique([user_id, type])` guarantees one (W1 added it after a live run found two and `findFirst`
 * became a coin toss between hashes), and there is no create path — a person with no credential row has
 * never registered, and this write must not invent one.
 */

const CFG = {
  PASSWORD_MIN_LENGTH: 8,
  PASSWORD_REQUIRE_UPPERCASE: true,
  PASSWORD_REQUIRE_DIGIT: true,
  PASSWORD_REQUIRE_SYMBOL: true,
} as unknown as AuthConfig;

const NOW = new Date('2026-08-13T12:00:00.000Z');

function build(opts: { hasCredential?: boolean; revoked?: number } = {}) {
  const row = { id: 'cred-1', user_id: 'u-1', type: 'password', secret_hash: 'OLD-HASH' };
  const writes: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];

  const prisma = {
    credential: {
      findFirst: async () => ((opts.hasCredential ?? true) ? { ...row } : null),
    },
    async $transaction(fn: (tx: unknown) => Promise<number>) {
      return fn({
        credential: {
          update: async (args: Record<string, unknown>) => {
            writes.push(args);
            return {};
          },
        },
      });
    },
  } as unknown as PrismaService;

  const tokens = {
    hashPassword: async (plain: string) => `HASH(${plain})`,
    verifyPassword: async (hash: string, plain: string) => hash === `HASH(${plain})` || hash === 'OLD-HASH' && plain === 'Old#Passw0rd',
  } as unknown as TokenService;

  const refresh = {
    revokeUserChain: async () => opts.revoked ?? 3,
  } as unknown as RefreshService;

  const audit = {
    append: async (accountId: string, input: Record<string, unknown>) => {
      audits.push({ accountId, ...input });
    },
  } as unknown as AuditRepository;

  const service = new PasswordService(
    CFG,
    { now: () => NOW },
    prisma,
    tokens,
    refresh,
    audit,
  );
  return { service, writes, audits };
}

const input = (over: Partial<SetPasswordInput> = {}): SetPasswordInput => ({
  accountId: 'acc-1',
  userId: 'u-1',
  newPassword: 'New#Passw0rd',
  action: 'password.changed',
  actor: { userId: 'u-1' },
  ...over,
});

describe('⭐ the write does all four things, or none of them (the positive control first)', () => {
  it('stores the new hash, moves last_rotated_at, revokes every session, writes ONE entry', async () => {
    const { service, writes, audits } = build({ revoked: 4 });

    const out = await service.setPassword(input());

    expect(out).toEqual({ status: 'ok', revokedCount: 4 });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.data).toEqual({ secret_hash: 'HASH(New#Passw0rd)', last_rotated_at: NOW });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      accountId: 'acc-1',
      action: 'password.changed',
      actorUserId: 'u-1',
      targetRef: 'u-1',
      detail: { reasonClass: 'ok', revokedCount: 4 },
    });
  });

  it('the recovery path records the SAME write under its own action and a system actor', async () => {
    const { service, audits } = build();
    await service.setPassword(
      input({ action: 'recovery.completed', actor: { systemRef: 'password-recovery' } }),
    );
    expect(audits[0]).toMatchObject({
      action: 'recovery.completed',
      actorKind: 'system',
      actorRef: 'password-recovery',
      actorUserId: '',
      targetRef: 'u-1',
    });
  });

  it('the revoked count is REPORTED, because «signed out everywhere» has a bound to show', async () => {
    const { service } = build({ revoked: 0 });
    // Zero is a legitimate answer (nobody was signed in) and must not read as a failure.
    await expect(service.setPassword(input())).resolves.toEqual({ status: 'ok', revokedCount: 0 });
  });
});

describe('*** the policy is enforced HERE, so both surfaces cannot disagree ***', () => {
  it.each([
    ['short', 'Ab#1'],
    ['no uppercase', 'new#passw0rd'],
    ['no digit', 'New#Password'],
    ['no symbol', 'NewPassw0rd'],
  ])('refuses a %s password and writes NOTHING', async (_name, password) => {
    const { service, writes, audits } = build();
    const out = await service.setPassword(input({ newPassword: password }));
    expect(out.status).toBe('weak');
    expect(out.status === 'weak' && out.failures.length).toBeGreaterThan(0);
    // The negative control's other half: a refusal leaves no row and no entry behind.
    expect(writes).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('names WHICH rules failed, from the policy’s own closed vocabulary', async () => {
    const { service } = build();
    const out = await service.setPassword(input({ newPassword: 'abc' }));
    expect(out.status === 'weak' && out.failures.sort()).toEqual(
      ['digit', 'min_length', 'symbol', 'uppercase'].sort(),
    );
  });
});

describe('*** a person with no credential row is refused, never given one ***', () => {
  it('answers no_credential and writes nothing', async () => {
    const { service, writes, audits } = build({ hasCredential: false });
    // An invited person who never registered has no credential row. Creating one here would let a
    // recovery link complete a registration it was never part of.
    await expect(service.setPassword(input())).resolves.toEqual({ status: 'no_credential' });
    expect(writes).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});

describe('matchesCurrent — the CHANGE path’s own question', () => {
  it('is true for the stored password and false for another', async () => {
    const { service } = build();
    await expect(service.matchesCurrent('u-1', 'Old#Passw0rd')).resolves.toBe(true);
    await expect(service.matchesCurrent('u-1', 'Something#Else1')).resolves.toBe(false);
  });

  it('is false when there is no credential at all — never a crash, never a true', async () => {
    const { service } = build({ hasCredential: false });
    await expect(service.matchesCurrent('u-1', 'anything')).resolves.toBe(false);
  });
});
