/**
 * Account-scoped models in auth_db — the tables the isolation extension (feature 007) enforces
 * `account_id` on. Join tables (UserRole) are omitted: they carry no account_id and are scoped
 * through their in-schema parents. Cross-checked against schema.prisma by
 * tests/data-model/account-scope-coverage.spec.ts so a new tenant table cannot silently escape.
 */
export const SCOPED_MODELS = [
  'User',
  'Credential',
  'Role',
  'LoginCode',
  'RefreshToken',
  // Feature 010 (account lifecycle). Enrolled for WRITE-PATH coverage; the pre-account bootstrap
  // *reads* (whitelist-by-email, invite-by-token) intentionally use the RAW client (like the 009
  // login lookup) — a scoped read would fail-closed with no account context.
  'SuperadminWhitelist',
  'Invitation',
  // Feature 011 (RBAC). Only the tables that declare account_id are enrolled; the join/child
  // tables (RolePermission, UserPermissionEntry) carry no account_id and are scoped via their
  // in-schema parents (Role / User + Permission) — like UserRole.
  'Permission',
  'UserPermissionSet',
  'PrivilegeAudit',
] as const;
