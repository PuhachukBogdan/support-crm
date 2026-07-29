import {
  SEED_ACCOUNT_ID,
  SEED_AUTH_USER_ID,
  SEED_OPERATOR_ID,
  SEED_PLAYER_ID,
  SEED_BRAND_ID,
  SEED_BRAND_ID_2,
} from '@crm/common';

/**
 * Pure synthetic dataset for users_db (feature 008). No I/O — unit-testable (Track A).
 * The GR8 cache seam is left unpopulated/stale (7.4 populates it).
 *
 * ── ⚠️ THE COLLISION IS A PERMANENT FIXTURE (feature 020) ───────────────────────────────────────
 * The same platform `player_id` appears under BOTH brands, as TWO DIFFERENT PEOPLE with different
 * notes, different VIP flags and different segments. That is not a contrived test case: GR8's
 * `player_id` is unique only WITHIN a brand, so this is what the real data looks like.
 *
 * It lives in the seed rather than in one test's setup so that **every** future live run carries it.
 * The defect it guards against — two customers collapsing into one row, and one person's card showing
 * another's conversations — survived four phases precisely because nothing routinely exercised it.
 * A fixture that has to be staged is a fixture that gets skipped.
 *
 * The brand-union edge is gone with `PlayerBrand`: a row's brand is part of its key now. A human who
 * genuinely plays under both brands is a `Person`, established from a matching email or phone.
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
        brand_id: SEED_BRAND_ID,
        account_id: SEED_ACCOUNT_ID,
        vip: false,
        segment: 'standard',
        am_notes: null,
        gr8_stale: true, // GR8 seam unpopulated → stale/unknown
      },
      {
        // SAME platform id, OTHER brand, DIFFERENT person. Every field that differs here is a field
        // the old single-column key would have silently overwritten with the other person's value.
        player_id: SEED_PLAYER_ID,
        brand_id: SEED_BRAND_ID_2,
        account_id: SEED_ACCOUNT_ID,
        vip: true,
        segment: 'high-roller',
        am_notes: 'second brand, different human — feature 020 collision fixture',
        gr8_stale: true,
      },
    ],
  };
}

export type UsersSeed = ReturnType<typeof buildSeed>;
