/**
 * Account-scoped models in auth_db — the tables the isolation extension (feature 007) enforces
 * `account_id` on. Join tables (UserRole) are omitted: they carry no account_id and are scoped
 * through their in-schema parents. Cross-checked against schema.prisma by
 * tests/data-model/account-scope-coverage.spec.ts so a new tenant table cannot silently escape.
 */
export const SCOPED_MODELS = ['User', 'Credential', 'Role'] as const;
