/**
 * Account-scoped models in users_db — the tables the isolation extension (feature 007) enforces
 * `account_id` on. The PlayerBrand join/union edge is omitted: it carries no account_id and is
 * scoped through the Player parent (the player-union brand exception is brand-level, never account-
 * level — see data-model.md). Cross-checked against schema.prisma by
 * tests/data-model/account-scope-coverage.spec.ts.
 */
export const SCOPED_MODELS = [
  'Operator',
  'Player',
  // Feature 015 (roadmap 4.8): the general audit trail. Identical model in all three services —
  // the table cannot be shared (Principle VIII) and the entry lives in its action's transaction.
  'AuditEntry',
  // Feature 016 (roadmap 4.9): upload records. Every read and write goes through `forAccount`, so
  // "not yours" and "does not exist" are the same query result rather than two branches a future
  // edit could separate (FR-011). The storage key's account prefix is legibility, NOT authorization.
  'Upload',
] as const;
