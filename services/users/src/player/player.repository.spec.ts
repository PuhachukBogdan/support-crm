import { PlayerRepository } from './player.repository';
import type { PrismaService } from '../prisma.service';

/**
 * Read-by-player_id (feature 006 US3) — now account-scoped (feature 007): the repository reads
 * through `prisma.forAccount(accountId)`, so the player is confined to the caller's account while
 * the brand-union is preserved. Prisma is mocked (Track A) — live read-back runs on beton-test.
 */
function mockPrisma(findUnique: jest.Mock) {
  const forAccount = jest.fn().mockReturnValue({ player: { findUnique } });
  return { prisma: { forAccount } as unknown as PrismaService, forAccount };
}

describe('PlayerRepository.getPlayerById', () => {
  it('reads a unified, account-scoped player (brand-union + opaque snapshot) by its domain key', async () => {
    const player = {
      player_id: 'p-1',
      account_id: 'acc-1',
      vip: true,
      segment: 'vip',
      am_notes: 'prefers evening calls',
      preferences: { channel: 'telegram' },
      portfolio: null,
      gr8_snapshot: { raw: 'opaque-vendor-payload' },
      gr8_fetched_at: new Date('2026-07-18T00:00:00Z'),
      gr8_stale: false,
      brands: [
        { player_id: 'p-1', brand_id: 'bow' },
        { player_id: 'p-1', brand_id: 'bow2' },
      ],
    };
    const findUnique = jest.fn().mockResolvedValue(player);
    const { prisma, forAccount } = mockPrisma(findUnique);

    const res = await new PlayerRepository(prisma).getPlayerById('acc-1', 'p-1');

    // Read went through the account-scoped client (isolation, feature 007).
    expect(forAccount).toHaveBeenCalledWith('acc-1');
    expect(findUnique).toHaveBeenCalledWith({
      where: { player_id: 'p-1' },
      include: { brands: true },
    });
    // Unified across ≥2 brands (the brand-union exception is preserved).
    expect(res?.brands).toHaveLength(2);
    expect(res?.brands.map((b) => b.brand_id)).toEqual(['bow', 'bow2']);
    // Our own fields + opaque GR8 blob (stored verbatim, not typed).
    expect(res?.am_notes).toBe('prefers evening calls');
    expect(res?.gr8_snapshot).toEqual({ raw: 'opaque-vendor-payload' });
    expect(res?.gr8_stale).toBe(false);
  });

  it('returns null for an unknown player_id', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const { prisma } = mockPrisma(findUnique);

    const res = await new PlayerRepository(prisma).getPlayerById('acc-1', 'missing');

    expect(res).toBeNull();
  });
});
