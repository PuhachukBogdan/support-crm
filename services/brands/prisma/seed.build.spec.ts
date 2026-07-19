import { buildSeed } from './seed.build';
import { SEED_ACCOUNT_ID, SEED_BRAND_ID, SEED_BRAND_SLUG, SEED_OPERATOR_ID } from '@crm/common';

/**
 * US1 (feature 008): the brands seed builder yields one NEUTRAL brand + a brand-access rule referencing
 * the shared operator. Pure — no DB (Track A).
 */
describe('brands seed builder', () => {
  const seed = buildSeed();

  it('every tenant row carries the seed account_id (SC-003)', () => {
    for (const row of [...seed.brands, ...seed.brandAccessRules]) {
      expect(row.account_id).toBe(SEED_ACCOUNT_ID);
    }
  });

  it('the brand is neutral (shared id + placeholder slug, no real identity) (SC-004)', () => {
    expect(seed.brands[0]!.id).toBe(SEED_BRAND_ID);
    expect(seed.brands[0]!.slug).toBe(SEED_BRAND_SLUG);
  });

  it('the brand-access rule references the shared brand + operator (soft refs)', () => {
    expect(seed.brandAccessRules[0]!.brand_id).toBe(SEED_BRAND_ID);
    expect(seed.brandAccessRules[0]!.operator_id).toBe(SEED_OPERATOR_ID);
  });
});
