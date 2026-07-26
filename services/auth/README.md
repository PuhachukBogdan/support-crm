# auth

Authentication / identity service. **State:** a bootable **gRPC microservice** that owns `auth_db`
and implements the **login & session engine** (feature 009) plus the **account lifecycle** (feature
010) — two-step login, JWT issuance, rotating sessions, lockout, super-admin whitelist onboarding,
admin invites, and invited-user registration — alongside `HealthService.Check`. It also **owns the
RBAC model** (feature 011): the permission registry, role defaults/templates, copy-on-write per-user
overrides, privilege-change audit, and effective-permission resolution. Enforcement runs in the
shared policy lib at the gateway + owning services; contact-field masking lives in `users`; the
"view-as-role" preview is at the gateway.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50051**) hosting `AuthService` + `HealthService`.
- Owns its **own** database `auth_db` via role `auth_user` — no cross-service DB access (Principle VIII).
- **Two-step login for all roles** (feature 009): `Login` verifies email+password and issues a one-time
  emailed code (no token yet); `VerifyLoginCode` consumes the code and mints the token pair. No
  credential-only path to any session — super-admin included (SEC-2). Short access JWT + rotating,
  DB-backed refresh (session = ~1d, ~7d with "remember me"); rotation revokes the prior token and
  detects reuse. Lockout after 5 consecutive failures (SEC-14) with an identity-only admin notice.
- **Account lifecycle (feature 010):** super-admins appear ONLY from the out-of-band
  `SuperadminWhitelist` — a generic `RequestActivation` (anti-enumeration) emails a code, then
  `CompleteActivation` sets a policy-compliant password and creates the active super-admin.
  Admin/super-admin issue **single-use, expiring invites** (`CreateInvitation`, hierarchy-enforced,
  rate-limited); the invited user **registers** (`StartRegistration`/`CompleteRegistration`) with a
  matching email + fresh emailed code + policy password. Set-time **password policy** (min length +
  upper/digit/symbol, configurable) is enforced at every set-password surface. Codes reuse `LoginCode`
  (purpose `activation`/`registration`); the target `User` is pre-created non-active (`pending`/`invited`).
- **RBAC (feature 011):** owns the permission model — `ListPermissionCatalogue`/`ListRoleDefaults`
  (registry by category, versioned; role templates), the copy-on-write personalization
  (`PersonalizeUser`/`PersonalizeGroup`, single-role group, `ResetToDefault`), `AssignRole`
  (refuses `super_admin` — whitelist only), and `ResolveEffectivePermissions` (the resolver the
  gateway calls on a cache miss). Management RPCs are super-admin-gated server-side (FR-018); every
  mutation writes a `PrivilegeAudit` (references only, no PII — 0019/SEC-29). Role defaults come from
  `src/rbac/catalogue.ts` (`ROLE_DEFAULTS`), also the whole-role reset source. See `src/rbac/`.
- Data model: `User` (+ `failed_login_count`/`locked_until`; statuses `active`/`disabled`/`pending`/`invited`),
  `Credential` (argon2id `secret_hash`), `Role`/`UserRole`, feature-009 `LoginCode` / `RefreshToken`,
  feature-010 `SuperadminWhitelist` / `Invitation`, and **feature-011** `Permission` / `RolePermission`
  / `UserPermissionSet` / `UserPermissionEntry` / `PrivilegeAudit` — every tenant table carries an
  indexed `account_id` seam (ADR 0003).
- Isolation (feature 007): tenant data flows via `PrismaService.forAccount(accountId)` (fail-closed) —
  see [`libs/common/src/account-scope.ts`](../../libs/common/src/account-scope.ts). The **pre-login
  credential lookup runs unscoped** (it *establishes* `account_id` — research R7); minted tokens are
  account-bound (regression-tested).

## Interfaces
- Owned gRPC contract: [`libs/proto/crm/auth/v1/auth.proto`](../../libs/proto/crm/auth/v1/auth.proto)
  (`AuthService`: `Login`→`LoginChallenge`, `VerifyLoginCode`, `ValidateToken`, `Refresh`, `Logout`,
  `ResendLoginCode`; **feature 010:** `RequestActivation`, `CompleteActivation`, `CreateInvitation`,
  `StartRegistration`, `CompleteRegistration`; **feature 011:** `ResolveEffectivePermissions`,
  `ListPermissionCatalogue`, `ListRoleDefaults`, `SetRoleDefault`, `PersonalizeUser`,
  `PersonalizeGroup`, `ResetToDefault`, `AssignRole`) + [`health.proto`](../../libs/proto/crm/health/v1/health.proto).
- DB schema (its own): [`prisma/schema.prisma`](prisma/schema.prisma) → `auth_db`.
- Outbound seams: `EmailPort` (dev in-memory outbox now; worker→SMTP + egress allow-list later) and
  `AdminNotificationPort` (identity-only lockout alert) — `src/auth/ports/`.

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`, **`JWT_SECRET`** (secret — shared with the gateway for local
verify). Tunables with safe defaults (overridable): `ACCESS_TTL`, `SESSION_TTL`, `REMEMBER_TTL`,
`CODE_TTL`, `CODE_LENGTH`, `CODE_MAX_ATTEMPTS`, `LOCKOUT_THRESHOLD`, `LOCKOUT_WINDOW`, argon2 cost;
**feature 010:** `PASSWORD_MIN_LENGTH` + `PASSWORD_REQUIRE_UPPERCASE`/`DIGIT`/`SYMBOL`, `INVITE_TTL`,
`INVITE_RATE_MAX`/`WINDOW`, `ONBOARD_REQUEST_RATE_MAX`/`WINDOW`. Validated at boot by
[`src/config.ts`](src/config.ts).

## Run / test
```bash
npm run test --workspace services/auth      # Track A: hermetic (mock Prisma, in-memory ports, fixed clock)
npm run prisma:deploy                        # Track B only (apply committed migrations to auth_db); then npm run seed
```
Runs as part of `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Gotchas
- Codes/passwords/tokens are **never** logged (Principle IV) — the dev EmailPort keeps codes in an
  inspectable outbox object, not the log.
- Does **not** connect to Postgres at boot — a downed DB degrades health, it doesn't crash startup.
- Access-JWT expiry is real-time (`jsonwebtoken`); OTP/refresh/lockout expiry uses the injectable clock.
