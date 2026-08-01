import { SCOPED_MODELS } from '../src/prisma.scoped-models';
import { PresenceRepository } from '../src/presence/presence.repository';
import { LabelsRepository } from '../src/presence/labels.repository';
import type { PrismaService } from '../src/prisma.service';

/**
 * Cross-account isolation for the presence layer (feature 025 / Principle I / SEC-17).
 *
 * ── The trap is built in deliberately ───────────────────────────────────────────────────────────
 * Both accounts hold presence for **the same `auth_user_id`**, a label with **the same id and the
 * same name**, and a channel block on **the same channel**. A repository that filtered after reading,
 * or that trusted an id supplied by the caller, would pass a naive test and fail this one.
 *
 * The fake `forAccount(acc)` reproduces what the feature-007 Prisma extension does — it confines
 * every operation to `acc`. So "not found" below is the STRUCTURAL consequence of scoping, not a
 * check the repository remembered to perform.
 *
 * ── Why presence deserves this as much as permissions do ────────────────────────────────────────
 * Presence is a routing input. A leak across the tenancy wall would not merely show the wrong data —
 * it would hand another tenant's customer conversation to somebody who does not work there.
 */

interface Row {
  [k: string]: unknown;
}

function makeStore() {
  // Same ids, same names, same channel — in BOTH accounts. The collision a guessing caller would try.
  const presence: Row[] = [
    { account_id: 'acc-1', auth_user_id: 'shared-user', state: 'online', last_cause: 'manual', last_seen_at: null, label_id: null },
    { account_id: 'acc-2', auth_user_id: 'shared-user', state: 'away', last_cause: 'admin', last_seen_at: null, label_id: null },
    { account_id: 'acc-2', auth_user_id: 'only-acc2', state: 'online', last_cause: 'manual', last_seen_at: null, label_id: null },
  ];
  const blocks: Row[] = [
    { account_id: 'acc-1', auth_user_id: 'shared-user', channel: 'email' },
    { account_id: 'acc-2', auth_user_id: 'shared-user', channel: 'live_chat' },
  ];
  const labels: Row[] = [
    { id: 'shared-label', account_id: 'acc-1', name: 'Lunch', state: 'away' },
    { id: 'shared-label', account_id: 'acc-2', name: 'Lunch', state: 'offline' },
  ];
  const operators: Row[] = [
    { id: 'op-1', account_id: 'acc-1', auth_user_id: 'shared-user', active: true },
    { id: 'op-2', account_id: 'acc-2', auth_user_id: 'shared-user', active: true },
    { id: 'op-3', account_id: 'acc-2', auth_user_id: 'only-acc2', active: true },
  ];

  const scopedTo = (acc: string) => {
    const inAcc = <T extends Row>(rows: T[]) => rows.filter((r) => r.account_id === acc);
    const matches = (r: Row, where: Record<string, unknown> = {}) =>
      Object.entries(where).every(([k, v]) => {
        if (v && typeof v === 'object' && 'in' in (v as Record<string, unknown>)) {
          return ((v as { in: unknown[] }).in ?? []).includes(r[k]);
        }
        return r[k] === v;
      });

    return {
      operatorPresence: {
        async findFirst({ where }: { where?: Record<string, unknown> } = {}) {
          return inAcc(presence).find((r) => matches(r, where)) ?? null;
        },
        async findMany({ where }: { where?: Record<string, unknown> } = {}) {
          return inAcc(presence).filter((r) => matches(r, where));
        },
      },
      operatorChannelBlock: {
        async findMany({ where }: { where?: Record<string, unknown> } = {}) {
          return inAcc(blocks).filter((r) => matches(r, where));
        },
      },
      presenceLabel: {
        async findMany() {
          return inAcc(labels);
        },
        async findFirst({ where }: { where?: Record<string, unknown> } = {}) {
          return inAcc(labels).find((r) => matches(r, where)) ?? null;
        },
      },
      operator: {
        async findFirst({ where }: { where?: Record<string, unknown> } = {}) {
          return inAcc(operators).find((r) => matches(r, where)) ?? null;
        },
      },
    };
  };

  const prisma = { forAccount: scopedTo } as unknown as PrismaService;
  return { prisma, presence, blocks, labels };
}

describe('presence is confined to one account (feature 025, Principle I)', () => {
  it('all four tables are enrolled in the scoped-model allow-list', () => {
    // The enrolment is what makes every assertion below structural rather than accidental — and
    // `tests/data-model/account-scope-coverage.spec.ts` fails the moment a tenant table is missing.
    for (const model of ['OperatorPresence', 'OperatorChannelBlock', 'PresenceLabel', 'OperatorTransition']) {
      expect(SCOPED_MODELS).toContain(model);
    }
  });

  it('⭐ the SAME auth user id reads a different presence in each account', async () => {
    const { prisma } = makeStore();
    const repo = new PresenceRepository(prisma);
    expect((await repo.read('acc-1', 'shared-user')).state).toBe('online');
    expect((await repo.read('acc-2', 'shared-user')).state).toBe('away');
  });

  it('another account’s operator is indistinguishable from one who does not exist', async () => {
    const { prisma } = makeStore();
    const repo = new PresenceRepository(prisma);
    // `only-acc2` exists — in the other account. From acc-1 the answer is the same as for a person
    // who was never hired, which is the point: absence and denial must not be tellable apart.
    expect(await repo.operatorFor('acc-1', 'only-acc2')).toBeNull();
    expect(await repo.operatorFor('acc-1', 'never-existed')).toBeNull();
  });

  it('a presence read for another account’s person answers the DEFAULT, never their row', async () => {
    const { prisma } = makeStore();
    const repo = new PresenceRepository(prisma);
    const row = await repo.read('acc-1', 'only-acc2');
    // Not `online` (their real state in acc-2) — the row is simply not visible, so the default applies.
    expect(row.state).toBe('offline');
    expect(row.last_cause).toBeNull();
  });

  it('⭐ channel blocks do not leak: the same channel is blocked in one account only', async () => {
    const { prisma } = makeStore();
    const repo = new PresenceRepository(prisma);
    expect((await repo.blockedChannels('acc-1', ['shared-user'])).get('shared-user')).toEqual(['email']);
    expect((await repo.blockedChannels('acc-2', ['shared-user'])).get('shared-user')).toEqual(['live_chat']);
  });

  it('a bulk read cannot be widened by asking for another account’s ids', async () => {
    const { prisma } = makeStore();
    const repo = new PresenceRepository(prisma);
    const rows = await repo.readMany('acc-1', ['shared-user', 'only-acc2']);
    expect([...rows.keys()]).toEqual(['shared-user']);
  });

  it('⭐ a label id that exists in BOTH accounts resolves to the caller’s own', async () => {
    const { prisma } = makeStore();
    const labels = new LabelsRepository(prisma);
    expect(await labels.exists('acc-1', 'shared-label')).toBe(true);
    const [one] = await labels.list('acc-1');
    expect(one).toMatchObject({ id: 'shared-label', state: 'away' }); // acc-2's copy says `offline`
  });

  it('a label list never crosses the wall', async () => {
    const { prisma } = makeStore();
    const labels = new LabelsRepository(prisma);
    expect(await labels.list('acc-1')).toHaveLength(1);
    expect(await labels.list('acc-3')).toEqual([]);
  });

  it('⚠️ the sweep is the ONE cross-account read, and it is deliberate', () => {
    // `idleSince` does not go through `forAccount` — the caller is a scheduler, not a session, and a
    // sweep confined to one account would need the worker to enumerate tenants, which is a list it
    // has no business holding. The rpc that reaches it is system-actor-only with no gateway route,
    // which is what makes the exception safe rather than merely convenient.
    const src = PresenceRepository.prototype.idleSince.toString();
    expect(src).not.toContain('forAccount');
    // …and it returns the account with each row, so every WRITE that follows is scoped again.
    expect(src).toContain('operatorPresence');
  });
});
