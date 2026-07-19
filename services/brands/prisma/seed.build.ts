import {
  SEED_ACCOUNT_ID,
  SEED_BRAND_ID,
  SEED_BRAND_SLUG,
  SEED_BRAND_ACCESS_RULE_ID,
  SEED_OPERATOR_ID,
} from '@crm/common';

/**
 * Pure synthetic dataset for brands_db (feature 008). No I/O — unit-testable (Track A). The brand is
 * NEUTRAL (placeholder slug, generic name — no real identity/logo/color; Principle VI).
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
    brandAccessRules: [
      {
        id: SEED_BRAND_ACCESS_RULE_ID,
        account_id: SEED_ACCOUNT_ID,
        brand_id: SEED_BRAND_ID,
        operator_id: SEED_OPERATOR_ID, // soft ref to users.Operator.id (no cross-service FK)
        access_level: 'answer',
      },
    ],
  };
}

export type BrandsSeed = ReturnType<typeof buildSeed>;
