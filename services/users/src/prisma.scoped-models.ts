/**
 * Account-scoped models in users_db — the tables the isolation extension (feature 007) enforces
 * `account_id` on. Cross-checked against schema.prisma by
 * `tests/data-model/account-scope-coverage.spec.ts`, which is what caught the three feature-020
 * tables below before they shipped unscoped.
 *
 * The old `PlayerBrand` edge used to be the documented omission here (no `account_id` of its own,
 * scoped through the Player parent). It is gone — feature 020 put the brand in the player's key —
 * so the exception it needed is gone with it.
 */
export const SCOPED_MODELS = [
  'Operator',
  'Player',
  // Feature 020 (roadmap 5.2): all three carry `account_id` and all three are tenant data. The
  // coverage guard failed the moment they were added without being listed here, which is the whole
  // reason that guard exists — an unscoped tenant table is a cross-account read waiting for a query.
  'ContactMatch',
  'Person',
  'PersonMember',
  // Feature 015 (roadmap 4.8): the general audit trail. Identical model in all three services —
  // the table cannot be shared (Principle VIII) and the entry lives in its action's transaction.
  'AuditEntry',
  // Feature 016 (roadmap 4.9): upload records. Every read and write goes through `forAccount`, so
  // "not yours" and "does not exist" are the same query result rather than two branches a future
  // edit could separate (FR-011). The storage key's account prefix is legibility, NOT authorization.
  'Upload',
] as const;
