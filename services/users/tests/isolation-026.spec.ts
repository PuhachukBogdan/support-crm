import { SCOPED_MODELS } from '../src/prisma.scoped-models';
import { AssignmentRepository } from '../src/assignment/assignment.repository';
import type { PrismaService } from '../src/prisma.service';

/**
 * Cross-account and cross-BRAND isolation for the attachment layer (feature 026 / Principle I).
 *
 * ── Two traps are built in, and the second is specific to this entity ───────────────────────────
 *  1. The usual one: **the same manager id in two accounts**, so a repository that filtered after
 *     reading would pass a naive test and fail this.
 *  2. ⭐ **The same `player_id` under two BRANDS.** Feature 020 established that the same platform id
 *     under brand A and brand B is routinely TWO DIFFERENT HUMAN BEINGS — and before 020 they
 *     collapsed into one row, so one customer's card served another's conversations. An attachment
 *     keyed on a bare `player_id` would recreate that defect **as an access grant**: attach to one
 *     person, read the other.
 *
 * The fake `forAccount(acc)` reproduces what the feature-007 extension does. So "not found" below is
 * the STRUCTURAL consequence of scoping, not a check somebody remembered to write.
 *
 * ⚠️ Why this matters more here than for most tables: an attachment is an **access input**. A leak
 * across either wall would not merely show the wrong data — it would hand a manager the private data
 * of somebody else's customer.
 */

interface Row {
  [k: string]: unknown;
}

function makeStore() {
  const rows: Row[] = [
    // Same manager, same platform id — three genuinely different situations.
    { id: 'a1', account_id: 'acc-1', brand_id: 'brand-a', player_id: 'shared-ply', am_auth_user_id: 'shared-am', ended_at: null },
    { id: 'a2', account_id: 'acc-2', brand_id: 'brand-a', player_id: 'shared-ply', am_auth_user_id: 'shared-am', ended_at: null },
    // ⭐ The cross-BRAND trap: same account, same platform id, DIFFERENT person.
    { id: 'a3', account_id: 'acc-1', brand_id: 'brand-b', player_id: 'shared-ply', am_auth_user_id: 'other-am', ended_at: null },
    // A closed period, which must never answer "who looks after them now".
    { id: 'a4', account_id: 'acc-1', brand_id: 'brand-a', player_id: 'ply-closed', am_auth_user_id: 'shared-am', ended_at: new Date('2026-07-01') },
  ];

  const matches = (r: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR' && Array.isArray(v)) return v.some((o) => matches(r, o as Record<string, unknown>));
      if (v && typeof v === 'object' && 'in' in (v as Record<string, unknown>)) {
        return ((v as { in: unknown[] }).in ?? []).includes(r[k]);
      }
      return r[k] === v;
    });

  const scopedTo = (acc: string) => {
    const inAcc = rows.filter((r) => r.account_id === acc);
    return {
      playerAssignment: {
        async findFirst({ where }: { where?: Record<string, unknown> } = {}) {
          return inAcc.find((r) => matches(r, where)) ?? null;
        },
        async findMany({ where }: { where?: Record<string, unknown> } = {}) {
          return inAcc.filter((r) => matches(r, where));
        },
      },
    };
  };

  return { prisma: { forAccount: scopedTo } as unknown as PrismaService, rows };
}

const repo = () => new AssignmentRepository(makeStore().prisma);

describe('an attachment never crosses an account or a brand (feature 026)', () => {
  it('the table is enrolled in the scoped-model allow-list', () => {
    expect(SCOPED_MODELS).toContain('PlayerAssignment');
  });

  it('the SAME manager holds different players in each account', async () => {
    const r = repo();
    expect((await r.activeFor('acc-1', { brandId: 'brand-a', playerId: 'shared-ply' }))?.id).toBe('a1');
    expect((await r.activeFor('acc-2', { brandId: 'brand-a', playerId: 'shared-ply' }))?.id).toBe('a2');
  });

  it('⭐ the same platform id under a DIFFERENT BRAND is a different person, with a different manager', async () => {
    // Before feature 020 these two collapsed into one row. Here that would mean attaching to one
    // customer and reading another's private data.
    const r = repo();
    expect((await r.activeFor('acc-1', { brandId: 'brand-a', playerId: 'shared-ply' }))?.am_auth_user_id).toBe('shared-am');
    expect((await r.activeFor('acc-1', { brandId: 'brand-b', playerId: 'shared-ply' }))?.am_auth_user_id).toBe('other-am');
  });

  it('⭐ `isAttached` respects BOTH walls', async () => {
    const r = repo();
    // The real attachment.
    expect(await r.isAttached('acc-1', { brandId: 'brand-a', playerId: 'shared-ply' }, 'shared-am')).toBe(true);
    // Same manager, same platform id — but the other account's row. Must be false, or the narrowing
    // would hand them another tenant's customer.
    expect(await r.isAttached('acc-3', { brandId: 'brand-a', playerId: 'shared-ply' }, 'shared-am')).toBe(false);
    // Same account, other brand: a different human being.
    expect(await r.isAttached('acc-1', { brandId: 'brand-b', playerId: 'shared-ply' }, 'shared-am')).toBe(false);
  });

  it('a CLOSED period never answers "who looks after them now"', async () => {
    const r = repo();
    expect(await r.activeFor('acc-1', { brandId: 'brand-a', playerId: 'ply-closed' })).toBeNull();
    expect(await r.isAttached('acc-1', { brandId: 'brand-a', playerId: 'ply-closed' }, 'shared-am')).toBe(false);
  });

  it('…but it is still THERE, which is the whole of FR-003', async () => {
    const r = repo();
    const history = await r.historyFor('acc-1', { brandId: 'brand-a', playerId: 'ply-closed' });
    expect(history).toHaveLength(1);
    expect(history[0]!.ended_at).not.toBeNull();
  });

  it('the page-at-a-time lookup cannot be widened by asking about another account’s players', async () => {
    const r = repo();
    const keys = await r.attachedAmong(
      'acc-3',
      [{ brandId: 'brand-a', playerId: 'shared-ply' }],
      'shared-am',
    );
    expect(keys.size).toBe(0);
  });

  it('and within an account it answers per BRAND, not per platform id', async () => {
    const r = repo();
    const keys = await r.attachedAmong(
      'acc-1',
      [
        { brandId: 'brand-a', playerId: 'shared-ply' },
        { brandId: 'brand-b', playerId: 'shared-ply' },
      ],
      'shared-am',
    );
    expect([...keys]).toEqual(['brand-a|shared-ply']);
  });

  it('"my players" never returns another account’s book', async () => {
    const r = repo();
    expect(await r.listActiveFor('acc-3', 'shared-am', 10)).toEqual([]);
    expect((await r.listActiveFor('acc-1', 'shared-am', 10)).map((x) => x.id)).toEqual(['a1']);
  });
});
