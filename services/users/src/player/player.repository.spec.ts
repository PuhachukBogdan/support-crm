import { PlayerRepository } from './player.repository';
import { playerIdentity, IncompletePlayerIdentityError } from './player.identity';
import type { PrismaService } from '../prisma.service';

/**
 * Read-by-identity (feature 006 US3; account-scoped since feature 007).
 *
 * ⚠️ **Rewritten by feature 020.** This spec used to assert the brand-union: one row carrying several
 * brands, read by `player_id` alone. That was the defect — GR8's `player_id` is unique only WITHIN a
 * brand, so a read by the platform id returned one row for what are two different customers. The
 * repository now takes the full triple, and a caller holding only a platform id cannot build one.
 *
 * Prisma is mocked (Track A); the live read-back runs on beton-test.
 */
function mockPrisma(findUnique: jest.Mock) {
  const forAccount = jest.fn().mockReturnValue({ player: { findUnique } });
  return { prisma: { forAccount } as unknown as PrismaService, forAccount };
}

const ID = playerIdentity({ accountId: 'acc-1', brandId: 'bow', playerId: 'p-1' });

describe('PlayerRepository.getPlayer', () => {
  it('reads an account-scoped player by the full identity', async () => {
    const player = {
      player_id: 'p-1',
      brand_id: 'bow',
      account_id: 'acc-1',
      vip: true,
      segment: 'vip',
      am_notes: 'prefers evening calls',
      preferences: { channel: 'telegram' },
      portfolio: null,
      gr8_snapshot: { raw: 'opaque-vendor-payload' },
      gr8_fetched_at: new Date('2026-07-18T00:00:00Z'),
      gr8_stale: false,
    };
    const findUnique = jest.fn().mockResolvedValue(player);
    const { prisma, forAccount } = mockPrisma(findUnique);

    const res = await new PlayerRepository(prisma).getPlayer(ID);

    // Read went through the account-scoped client (isolation, feature 007).
    expect(forAccount).toHaveBeenCalledWith('acc-1');

    // *** The whole feature in one assertion: all three parts reach the query. ***
    expect(findUnique).toHaveBeenCalledWith({
      where: {
        account_id_brand_id_player_id: {
          account_id: 'acc-1',
          brand_id: 'bow',
          player_id: 'p-1',
        },
      },
    });

    // The brand-union `include` is gone with the edge — one row is one brand's player.
    expect(findUnique.mock.calls[0]![0]).not.toHaveProperty('include');

    expect(res?.brand_id).toBe('bow');
    expect(res?.am_notes).toBe('prefers evening calls');
    expect(res?.gr8_snapshot).toEqual({ raw: 'opaque-vendor-payload' });
    expect(res?.gr8_stale).toBe(false);
  });

  it('*** the same platform id under another brand is a DIFFERENT query ***', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const { prisma } = mockPrisma(findUnique);
    const repo = new PlayerRepository(prisma);

    await repo.getPlayer(playerIdentity({ accountId: 'acc-1', brandId: 'bow', playerId: '12345' }));
    await repo.getPlayer(
      playerIdentity({ accountId: 'acc-1', brandId: 'bow2', playerId: '12345' }),
    );

    const [first, second] = findUnique.mock.calls.map(
      (c) => (c[0] as { where: { account_id_brand_id_player_id: { brand_id: string } } }).where,
    );
    expect(first).not.toEqual(second);
    // Before feature 020 both of these were `where: { player_id: '12345' }` — literally one row.
    expect(first!.account_id_brand_id_player_id.brand_id).toBe('bow');
    expect(second!.account_id_brand_id_player_id.brand_id).toBe('bow2');
  });

  it('a caller holding only a platform id CANNOT reach the repository', () => {
    // Not "returns nothing" — cannot even construct the argument. That is the property a surrogate
    // key would have lost: those call sites would still compile and resolve the wrong person.
    expect(() => playerIdentity({ accountId: 'acc-1', playerId: 'p-1' })).toThrow(
      IncompletePlayerIdentityError,
    );
  });

  it('returns null for an unknown identity', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const { prisma } = mockPrisma(findUnique);

    const res = await new PlayerRepository(prisma).getPlayer(
      playerIdentity({ accountId: 'acc-1', brandId: 'bow', playerId: 'missing' }),
    );

    expect(res).toBeNull();
  });
});
