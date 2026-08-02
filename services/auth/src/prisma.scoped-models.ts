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
  // Feature 015 (roadmap 4.8): the general audit trail. Identical model in all three services —
  // the table cannot be shared (Principle VIII) and the entry lives in its action's transaction.
  'AuditEntry',
  // Feature 024 (roadmap 5.3): groups. Only `Group` declares account_id and is enrolled;
  // `GroupMember` and `GroupPermission` are join tables scoped through their in-schema parents
  // (Group / User / Permission) — the same treatment as UserRole and RolePermission.
  'Group',
  // Feature 028 (mail delivery): the outbox. It carries `account_id` like every tenant-owned
  // table, so it is enrolled — but note what that does NOT change: the recipient is copied from
  // the record that caused the message and is never read from a request, so no caller can address
  // a message anywhere. The scoping is here because the ROW is tenant data, not because the
  // address needed guarding.
  //
  // ⓘ Enrolled by a guard, not by hand: `account-scope-coverage.spec.ts` failed the moment the
  // table appeared, which is exactly the point of writing that cross-check in feature 007.
  'OutboundEmail',
] as const;
