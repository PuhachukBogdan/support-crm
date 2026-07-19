/**
 * Account-scoped models in users_db — the tables the isolation extension (feature 007) enforces
 * `account_id` on. The PlayerBrand join/union edge is omitted: it carries no account_id and is
 * scoped through the Player parent (the player-union brand exception is brand-level, never account-
 * level — see data-model.md). Cross-checked against schema.prisma by
 * tests/data-model/account-scope-coverage.spec.ts.
 */
export const SCOPED_MODELS = ['Operator', 'Player'] as const;
