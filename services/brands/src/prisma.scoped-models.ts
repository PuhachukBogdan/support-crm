/**
 * Account-scoped models in brands_db — the tables the isolation extension (feature 007) enforces
 * `account_id` on. Cross-checked against schema.prisma by
 * tests/data-model/account-scope-coverage.spec.ts so a new tenant table cannot silently escape.
 */
export const SCOPED_MODELS = ['Brand', 'BrandAccessRule'] as const;
