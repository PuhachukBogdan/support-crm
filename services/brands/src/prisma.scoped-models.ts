/**
 * Account-scoped models in brands_db — the tables the isolation extension (feature 007) enforces
 * `account_id` on. Cross-checked against schema.prisma by
 * tests/data-model/account-scope-coverage.spec.ts so a new tenant table cannot silently escape.
 */
/**
 * Feature 020: `BrandAccessRule` left this list with the table. There is one support department, so
 * a per-operator brand permission is not a concept in this product (ADR 0038 §1).
 */
export const SCOPED_MODELS = ['Brand'] as const;
