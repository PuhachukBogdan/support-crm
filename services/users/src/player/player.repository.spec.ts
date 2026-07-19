import { PlayerRepository } from './player.repository';
import type { PrismaService } from '../prisma.service';

/**
 * US3 acceptance (feature 006): the read-by-player_id path returns a single unified player with
 * its brand-union and the opaque GR8 snapshot. Prisma is mocked (Track A, Docker-independent) —
 * live read-back against real Postgres runs on beton-test (Track B, quickstart).
 */
describe('PlayerRepository.getPlayerById', () => {
  it('reads a unified player (brand-union + opaque snapshot) by its domain key', async () => {
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
    const prisma = { player: { findUnique } } as unknown as PrismaService;

    const res = await new PlayerRepository(prisma).getPlayerById('p-1');

    expect(findUnique).toHaveBeenCalledWith({
      where: { player_id: 'p-1' },
      include: { brands: true },
    });
    // Unified across ≥2 brands.
    expect(res?.brands).toHaveLength(2);
    expect(res?.brands.map((b) => b.brand_id)).toEqual(['bow', 'bow2']);
    // Our own fields + opaque GR8 blob (stored verbatim, not typed).
    expect(res?.am_notes).toBe('prefers evening calls');
    expect(res?.gr8_snapshot).toEqual({ raw: 'opaque-vendor-payload' });
    expect(res?.gr8_stale).toBe(false);
  });

  it('returns null for an unknown player_id', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const prisma = { player: { findUnique } } as unknown as PrismaService;

    const res = await new PlayerRepository(prisma).getPlayerById('missing');

    expect(res).toBeNull();
  });
});
