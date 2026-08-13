import { AuditRepository } from '../audit/audit.repository';
import {
  ContactLookupService,
  LookupRateCapped,
  LOOKUP_CAP_MAX,
} from './contact-lookup.service';
import { contactHash } from './contact-match';
import type { PrismaService } from '../prisma.service';

/**
 * W9 / spec 035 — the lookup's invariants (ADR 0044 §4). The permission gate is the decorator, pinned
 * in `contact-lookup-gate.spec.ts` alongside; what THIS file proves is the service's own contract:
 * every attempt audited with hash-not-value, the cap counted on the trail, ambiguity naming nobody,
 * and brand-scoping (a match on another brand is another human being).
 */

const SALT = 's'.repeat(32);
const HASH = (value: string, kind: 'email' | 'phone' = 'email') => contactHash(kind, value, SALT)!;

function fakeDb(opts: { matches?: { player_id: string; brand_id: string }[]; recent?: number } = {}) {
  const auditCreate = jest.fn(async () => ({}));
  const scoped = {
    auditEntry: {
      count: jest.fn(async () => opts.recent ?? 0),
      create: auditCreate,
    },
    contactMatch: {
      findMany: jest.fn(async ({ where }: { where: { brand_id: string } }) =>
        (opts.matches ?? []).filter((m) => m.brand_id === where.brand_id).slice(0, 2),
      ),
    },
  };
  const prisma = { forAccount: jest.fn(() => scoped) } as unknown as PrismaService;
  return { prisma, scoped, auditCreate };
}

const build = (db: ReturnType<typeof fakeDb>) =>
  new ContactLookupService(db.prisma, new AuditRepository(db.prisma), SALT);

const lastEntry = (db: ReturnType<typeof fakeDb>) =>
  (db.auditCreate.mock.calls.at(-1) as unknown as [{ data: Record<string, unknown> }])[0];

describe('contact lookup — every attempt audited, hash never value', () => {
  it('a single match answers found — and the entry carries {valueHash, valueKind, matched}', async () => {
    const db = fakeDb({ matches: [{ player_id: 'p1', brand_id: 'brand-a' }] });
    const res = await build(db).lookup('acc-1', 'u1', { brandId: 'brand-a', kind: 'email', value: 'X@Y.test' });

    expect(res).toEqual({
      matched: true,
      ambiguous: false,
      playerId: 'p1',
      brandId: 'brand-a',
      // The caller (chats) writes its conversation-side transition under the SAME token.
      valueHash: HASH('X@Y.test'),
    });
    const entry = lastEntry(db).data;
    expect(entry.action).toBe('contact.lookup');
    expect(entry.detail_json).toMatchObject({
      valueHash: HASH('X@Y.test'),
      valueKind: 'email',
      matched: 'found',
    });
    // ⛔ The raw value appears NOWHERE in the entry — the whole point of the hash (0044 §4).
    const flat = JSON.stringify(entry).toLowerCase();
    expect(flat).not.toContain('x@y.test');
  });

  it('no match still writes an entry — an unanswered probe is still a probe', async () => {
    const db = fakeDb({ matches: [] });
    const res = await build(db).lookup('acc-1', 'u1', { brandId: 'brand-a', kind: 'phone', value: '+380501234567' });
    expect(res.matched).toBe(false);
    expect(lastEntry(db).data.detail_json).toMatchObject({ matched: 'none', valueKind: 'phone' });
  });

  it('⭐ two records sharing the contact answer AMBIGUOUS and name NOBODY', async () => {
    const db = fakeDb({
      matches: [
        { player_id: 'p1', brand_id: 'brand-a' },
        { player_id: 'p2', brand_id: 'brand-a' },
      ],
    });
    const res = await build(db).lookup('acc-1', 'u1', { brandId: 'brand-a', kind: 'email', value: 'x@y.test' });
    expect(res).toEqual({
      matched: false,
      ambiguous: true,
      playerId: '',
      brandId: 'brand-a',
      valueHash: HASH('x@y.test'),
    });
    expect(lastEntry(db).data.detail_json).toMatchObject({ matched: 'ambiguous' });
  });

  it('⭐ a match on ANOTHER brand answers none — another brand is another human being', async () => {
    const db = fakeDb({ matches: [{ player_id: 'p1', brand_id: 'brand-B' }] });
    const res = await build(db).lookup('acc-1', 'u1', { brandId: 'brand-a', kind: 'email', value: 'x@y.test' });
    expect(res.matched).toBe(false);
    expect(res.ambiguous).toBe(false);
  });

  it(`⭐ the ${LOOKUP_CAP_MAX + 1}th attempt in the window is REFUSED — and audited as rate_capped`, async () => {
    const db = fakeDb({ recent: LOOKUP_CAP_MAX });
    await expect(
      build(db).lookup('acc-1', 'u1', { brandId: 'brand-a', kind: 'email', value: 'x@y.test' }),
    ).rejects.toBeInstanceOf(LookupRateCapped);
    // The refusal is a data point: volume over time is the only available anomaly signal.
    expect(lastEntry(db).data.detail_json).toMatchObject({ matched: 'rate_capped' });
    // And nothing was searched: the match query never ran.
    expect(db.scoped.contactMatch.findMany).not.toHaveBeenCalled();
  });

  it('the cap counts the TRAIL itself, per actor, within the window', async () => {
    const db = fakeDb({ matches: [] });
    await build(db).lookup('acc-1', 'u7', { brandId: 'brand-a', kind: 'email', value: 'x@y.test' });
    const [{ where }] = db.scoped.auditEntry.count.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ];
    expect(where.actor_user_id).toBe('u7');
    expect(where.action).toBe('contact.lookup');
    expect(where.created_at).toBeDefined();
  });
});
