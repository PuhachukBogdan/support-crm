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
  // Feature 021 (roadmap 5.6): the operator's own appearance settings. Cosmetic, but still tenant
  // data — a person belongs to an account, and `forAccount` is what makes "not yours" and "does not
  // exist" the same query result rather than two branches a later edit could separate.
  'OperatorUiPreference',
  // Feature 025 (roadmap 5.9): presence and everything that narrows it. All four carry `account_id`
  // and are all four tenant data.
  //
  // ⚠️ Note the contrast with feature 024's `GroupMember` / `GroupPermission`, which deliberately
  // carry NO `account_id` and scope through a parent row so there is only ever one answer to "which
  // account is this in?". There is no parent row here: `auth_user_id` is a soft ref that cannot be a
  // foreign key across a service boundary, so each table carries the account itself. Different
  // shapes, same guarantee.
  'OperatorPresence',
  'OperatorChannelBlock',
  'PresenceLabel',
  'OperatorTransition',
  // Feature 026 (roadmap 5.7): who looks after which player. Tenant data, and an ACCESS INPUT —
  // a row here decides what a manager may read, so a leak across the tenancy wall would not merely
  // show the wrong data, it would grant the wrong access. Same reasoning as the group tables.
  'PlayerAssignment',
] as const;
