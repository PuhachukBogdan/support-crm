import { SEED_ACCOUNT_ID, SEED_BRAND_ID, SEED_BRAND_SLUG } from '@crm/common';

/**
 * Pure synthetic dataset for brands_db (feature 008). No I/O — unit-testable (Track A). The brand is
 * NEUTRAL (placeholder slug, generic name — no real identity/logo/color; Principle VI).
 *
 * ⚠️ **There is no `brandAccessRules` here, and its absence is the point** (ADR 0038 §1). Brand scope was
 * removed — a brand is part of a player's identity and a filter a caller may ask for, never a permission —
 * and the table went with it (migration `20260802000000_drop_brand_access_rules`).
 *
 * ⭐ This dataset outlived the table by three days: the runner kept calling `db.brandAccessRule.upsert`,
 * which is `undefined` on a client generated from a schema that no longer declares the model, so
 * **`npm run seed:brands` threw on every run from 2026-08-02 until 2026-08-05**. Nothing noticed, because
 * the brands seed is only re-run when a stand is rebuilt — and the brand rows themselves are written
 * before the failing loop, so the stand looked correctly seeded.
 */
export function buildSeed() {
  return {
    brands: [
      {
        id: SEED_BRAND_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'Bow (demo brand)',
        slug: SEED_BRAND_SLUG,
        active: true,
      },
    ],
  };
}

export type BrandsSeed = ReturnType<typeof buildSeed>;
