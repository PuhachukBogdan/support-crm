import {
  SEED_ACCOUNT_ID,
  SEED_AUTH_USER_ID,
  SEED_OPERATOR_ID,
  SEED_PLAYER_ID,
  SEED_BRAND_ID,
} from '@crm/common';

/**
 * Pure synthetic dataset for users_db (feature 008). No I/O — unit-testable (Track A). The player
 * links the brand via the union edge; the GR8 cache seam is left unpopulated/stale (7.4 populates it).
 */
export function buildSeed() {
  return {
    operators: [
      {
        id: SEED_OPERATOR_ID,
        account_id: SEED_ACCOUNT_ID,
        auth_user_id: SEED_AUTH_USER_ID, // soft ref to auth.User.id (no cross-service FK)
        display_name: 'Seed Operator',
        active: true,
      },
    ],
    players: [
      {
        player_id: SEED_PLAYER_ID,
        account_id: SEED_ACCOUNT_ID,
        vip: false,
        segment: 'standard',
        am_notes: null,
        gr8_stale: true, // GR8 seam unpopulated → stale/unknown
      },
    ],
    playerBrands: [{ player_id: SEED_PLAYER_ID, brand_id: SEED_BRAND_ID }],
  };
}

export type UsersSeed = ReturnType<typeof buildSeed>;
