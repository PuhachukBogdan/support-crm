import type { PrismaService } from '../prisma.service';
import { PlayerRepository } from './player.repository';

interface Member {
  account_id: string;
  brand_id: string;
  player_id: string;
  person_id: string;
}

const MEMBERS: Member[] = [
  { account_id: 'acc-1', brand_id: 'brand-a', player_id: 'p1', person_id: 'person-1' },
  { account_id: 'acc-1', brand_id: 'brand-b', player_id: 'p2', person_id: 'person-1' },
  { account_id: 'acc-1', brand_id: 'brand-a', player_id: 'p3', person_id: 'person-2' },
  // Another tenant's link for the SAME identifiers — the case that only `account_id` separates.
  { account_id: 'acc-2', brand_id: 'brand-a', player_id: 'p9', person_id: 'person-x' },
];

function row(playerId: string, brandId = 'brand-a', accountId = 'acc-1') {
  return {
    player_id: playerId,
    brand_id: brandId,
    account_id: accountId,
    vip: false,
    segment: null,
    am_notes: null,
    preferences: null,
    portfolio: null,
    custom_attributes: null,
    gr8_snapshot: null,
    gr8_fetched_at: null,
    gr8_stale: false,
    created_at: new Date('2026-07-01T00:00:00Z'),
    updated_at: new Date('2026-07-01T00:00:00Z'),
  };
}

/**
 * A fake that applies the account predicate and the `in` filter, and COUNTS its calls — the count is the
 * whole point of the batched lookup (one query per page, never one per row).
 */
function fakePrisma(players: ReturnType<typeof row>[]) {
  const memberFindMany = jest.fn((args: { where: Record<string, unknown> }) => {
    const w = args.where;
    let rows = MEMBERS.filter((m) => m.account_id === w.account_id);
    if (w.brand_id) rows = rows.filter((m) => m.brand_id === w.brand_id);
    const pid = w.player_id as string | { in?: string[] } | undefined;
    if (typeof pid === 'string') rows = rows.filter((m) => m.player_id === pid);
    else if (pid?.in) rows = rows.filter((m) => pid.in!.includes(m.player_id));
    return Promise.resolve(rows);
  });
  const forAccount = jest.fn((accountId: string) => ({
    player: {
      findUnique: (args: { where: { account_id_brand_id_player_id?: Record<string, string> } }) => {
        const k = args.where.account_id_brand_id_player_id!;
        return Promise.resolve(
          players.find(
            (p) =>
              p.account_id === accountId &&
              p.brand_id === k.brand_id &&
              p.player_id === k.player_id,
          ) ?? null,
        );
      },
      findMany: () => Promise.resolve(players.filter((p) => p.account_id === accountId)),
    },
    personMember: {
      findMany: (args: { where: Record<string, unknown> }) =>
        memberFindMany({ ...args, where: { ...args.where, account_id: accountId } }),
    },
  }));
  return { prisma: { forAccount } as unknown as PrismaService, memberFindMany };
}

/**
 * Feature 022 (roadmap 4.13), T046 — **the player record says which HUMAN it belongs to.**
 *
 * ── Why this had to be added ────────────────────────────────────────────────────────────────────
 * Feature 020 stored the cross-brand link and exposed it in ONE direction: `ListPersonMembers(person_id)`
 * → members. Every card, however, is opened on a brand-scoped PLAYER record — so the person-level reads
 * 020 declared were unaddressable, because the caller had no way to obtain the identifier they need. A
 * link that cannot be reached from the side the product reads from is the same defect as an rpc nothing
 * serves, one layer down.
 *
 * ── Why the lookup is batched for a page ────────────────────────────────────────────────────────
 * `ListPlayersByBrand` returns a page. One lookup per row would be a textbook N+1 (Principle VII) — and
 * the kind that only shows up as a slow card once a brand has thousands of customers.
 */
describe('PlayerRepository — the person a record belongs to', () => {
  it('a linked player reports its person', async () => {
    const { prisma } = fakePrisma([row('p1')]);
    const repo = new PlayerRepository(prisma);
    const p = await repo.getPlayer({ accountId: 'acc-1', brandId: 'brand-a', playerId: 'p1' });
    expect(p).not.toBeNull();
    expect(await repo.personIdOf({ accountId: 'acc-1', brandId: 'brand-a', playerId: 'p1' })).toBe(
      'person-1',
    );
  });

  it('two records of the SAME person both report it — that is what makes them one human', async () => {
    const { prisma } = fakePrisma([row('p1'), row('p2', 'brand-b')]);
    const repo = new PlayerRepository(prisma);
    expect(await repo.personIdOf({ accountId: 'acc-1', brandId: 'brand-a', playerId: 'p1' })).toBe(
      'person-1',
    );
    expect(await repo.personIdOf({ accountId: 'acc-1', brandId: 'brand-b', playerId: 'p2' })).toBe(
      'person-1',
    );
  });

  it('an UNLINKED player reports null — not an error, and not a synthesised person of one', async () => {
    // A person of one exists as a data state (an unlink can leave one), but it is never invented here: a
    // caller must be able to tell "not linked to anybody" from "linked to a person with one member".
    const { prisma } = fakePrisma([row('p-solo')]);
    const repo = new PlayerRepository(prisma);
    expect(
      await repo.personIdOf({ accountId: 'acc-1', brandId: 'brand-a', playerId: 'p-solo' }),
    ).toBeNull();
  });

  it('is bounded by the account: another tenant’s link is invisible', async () => {
    const { prisma } = fakePrisma([row('p9')]);
    const repo = new PlayerRepository(prisma);
    // `p9` IS linked — in acc-2. Asking as acc-1 must find nothing rather than leak the person id.
    expect(
      await repo.personIdOf({ accountId: 'acc-1', brandId: 'brand-a', playerId: 'p9' }),
    ).toBeNull();
    expect(await repo.personIdOf({ accountId: 'acc-2', brandId: 'brand-a', playerId: 'p9' })).toBe(
      'person-x',
    );
  });

  it('is bounded by the brand: the same platform id under another brand is another record', async () => {
    // The 5.2 rule, applied to this lookup too. `p1` is linked under brand-a; under brand-c it is either a
    // different human or nobody, and it must not inherit brand-a's person.
    const { prisma } = fakePrisma([row('p1')]);
    const repo = new PlayerRepository(prisma);
    expect(
      await repo.personIdOf({ accountId: 'acc-1', brandId: 'brand-c', playerId: 'p1' }),
    ).toBeNull();
  });

  it('resolves a whole PAGE in ONE query (never one per row)', async () => {
    const players = [row('p1'), row('p3'), row('p-solo')];
    const { prisma, memberFindMany } = fakePrisma(players);
    const repo = new PlayerRepository(prisma);
    const map = await repo.personIdsFor('acc-1', 'brand-a', ['p1', 'p3', 'p-solo']);
    expect(memberFindMany).toHaveBeenCalledTimes(1);
    expect(map.get('p1')).toBe('person-1');
    expect(map.get('p3')).toBe('person-2');
    expect(map.has('p-solo')).toBe(false);
  });

  it('an empty page asks nothing at all', async () => {
    const { prisma, memberFindMany } = fakePrisma([]);
    const map = await new PlayerRepository(prisma).personIdsFor('acc-1', 'brand-a', []);
    expect(map.size).toBe(0);
    expect(memberFindMany).not.toHaveBeenCalled();
  });

  it('the page lookup is bounded by the account too', async () => {
    const { prisma } = fakePrisma([row('p9')]);
    const map = await new PlayerRepository(prisma).personIdsFor('acc-1', 'brand-a', ['p9']);
    expect(map.has('p9')).toBe(false);
  });
});
