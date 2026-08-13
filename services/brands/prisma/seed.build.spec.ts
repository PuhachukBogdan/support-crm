import { buildSeed } from './seed.build';
import { SEED_ACCOUNT_ID, SEED_BRAND_ID, SEED_BRAND_SLUG } from '@crm/common';

/**
 * US1 (feature 008): the brands seed builder yields one NEUTRAL brand. Pure — no DB (Track A).
 *
 * ⚠️ It used to yield a brand-access rule as well, and this spec used to assert it. Both are gone with the
 * table (ADR 0038 §1) — the assertion is now the NEGATIVE one below, because a spec that still described
 * the rule is part of what kept a dropped model looking alive for three days.
 */
describe('brands seed builder', () => {
  const seed = buildSeed();

  it('every tenant row carries the seed account_id (SC-003)', () => {
    for (const row of seed.brands) {
      expect(row.account_id).toBe(SEED_ACCOUNT_ID);
    }
  });

  it('the brand is neutral (shared id + placeholder slug, no real identity) (SC-004)', () => {
    expect(seed.brands[0]!.id).toBe(SEED_BRAND_ID);
    expect(seed.brands[0]!.slug).toBe(SEED_BRAND_SLUG);
  });

  /**
   * The dataset names exactly the models `brands_db` still has. A key here that the schema dropped is a
   * runner that throws on `undefined.upsert` — the defect this replaces, and one no unit test could see
   * while the key was merely *present* rather than *written*.
   */
  it('describes nothing the schema no longer declares', () => {
    expect(Object.keys(seed)).toEqual(['brands']);
  });
});
