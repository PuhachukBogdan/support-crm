import { buildSeed } from './seed.build';
import {
  SEED_ACCOUNT_ID,
  SEED_AUTH_USER_ID,
  SEED_PLAYER_ID,
  SEED_BRAND_ID,
  SEED_BRAND_ID_2,
} from '@crm/common';

/**
 * US1 (feature 008): the users seed builder yields an operator + a player linked to the brand via the
 * union edge, with the GR8 seam unpopulated/stale. Pure — no DB (Track A).
 */
describe('users seed builder', () => {
  const seed = buildSeed();

  it('every tenant row carries the seed account_id (SC-003)', () => {
    for (const row of [...seed.operators, ...seed.players]) {
      expect(row.account_id).toBe(SEED_ACCOUNT_ID);
    }
  });

  it('the operator references the shared auth user (soft ref)', () => {
    expect(seed.operators[0]!.auth_user_id).toBe(SEED_AUTH_USER_ID);
  });

  it('*** the SAME platform id is seeded under BOTH brands, as two different people ***', () => {
    // Feature 020's permanent fixture. GR8's player_id is unique only within a brand, so this is what
    // real data looks like — and it is the case that four phases of tests never once exercised.
    expect(seed.players).toHaveLength(2);
    expect(seed.players.map((p) => p.player_id)).toEqual([SEED_PLAYER_ID, SEED_PLAYER_ID]);
    expect(seed.players.map((p) => p.brand_id)).toEqual([SEED_BRAND_ID, SEED_BRAND_ID_2]);
  });

  it('the two collide only on the id — every other field differs, and would have been overwritten', () => {
    const [a, b] = seed.players;
    expect(a!.vip).not.toBe(b!.vip);
    expect(a!.segment).not.toBe(b!.segment);
    expect(a!.am_notes).not.toBe(b!.am_notes);
  });

  it('the brand-union edge is gone — a row IS one brand’s player', () => {
    expect(seed).not.toHaveProperty('playerBrands');
  });

  it('the GR8 cache seam is left unpopulated/stale', () => {
    expect(seed.players[0]!.gr8_stale).toBe(true);
    expect(seed.players[0]!.gr8_snapshot ?? null).toBeNull();
  });
});
