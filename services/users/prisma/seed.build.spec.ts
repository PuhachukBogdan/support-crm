import { buildSeed } from './seed.build';
import { SEED_ACCOUNT_ID, SEED_AUTH_USER_ID, SEED_PLAYER_ID, SEED_BRAND_ID } from '@crm/common';

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

  it('the player is keyed by the shared player_id and links the brand via the union edge', () => {
    expect(seed.players[0]!.player_id).toBe(SEED_PLAYER_ID);
    expect(seed.playerBrands[0]).toEqual({ player_id: SEED_PLAYER_ID, brand_id: SEED_BRAND_ID });
  });

  it('the GR8 cache seam is left unpopulated/stale', () => {
    expect(seed.players[0]!.gr8_stale).toBe(true);
    expect(seed.players[0]!.gr8_snapshot ?? null).toBeNull();
  });
});
