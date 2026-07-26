# auth

Authentication / identity service. **State:** a bootable **gRPC microservice** that owns `auth_db`
and implements the **login & session engine** (Phase 3, feature 009) — two-step login, JWT issuance,
rotating sessions, and lockout — alongside `HealthService.Check`. RBAC enforcement + the full role
matrix are **feature 011**; invite/registration/whitelist onboarding is **feature 010**.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50051**) hosting `AuthService` + `HealthService`.
- Owns its **own** database `auth_db` via role `auth_user` — no cross-service DB access (Principle VIII).
- **Two-step login for all roles** (feature 009): `Login` verifies email+password and issues a one-time
  emailed code (no token yet); `VerifyLoginCode` consumes the code and mints the token pair. No
  credential-only path to any session — super-admin included (SEC-2). Short access JWT + rotating,
  DB-backed refresh (session = ~1d, ~7d with "remember me"); rotation revokes the prior token and
  detects reuse. Lockout after 5 consecutive failures (SEC-14) with an identity-only admin notice.
- Data model: `User` (+ `failed_login_count`/`locked_until`), `Credential` (argon2id `secret_hash`),
  `Role`/`UserRole`, and feature-009 `LoginCode` / `RefreshToken` — every tenant table carries an
  indexed `account_id` seam (ADR 0003).
- Isolation (feature 007): tenant data flows via `PrismaService.forAccount(accountId)` (fail-closed) —
  see [`libs/common/src/account-scope.ts`](../../libs/common/src/account-scope.ts). The **pre-login
  credential lookup runs unscoped** (it *establishes* `account_id` — research R7); minted tokens are
  account-bound (regression-tested).

## Interfaces
- Owned gRPC contract: [`libs/proto/crm/auth/v1/auth.proto`](../../libs/proto/crm/auth/v1/auth.proto)
  (`AuthService`: `Login`→`LoginChallenge`, `VerifyLoginCode`, `ValidateToken`, `Refresh`, `Logout`,
  `ResendLoginCode`) + [`health.proto`](../../libs/proto/crm/health/v1/health.proto).
- DB schema (its own): [`prisma/schema.prisma`](prisma/schema.prisma) → `auth_db`.
- Outbound seams: `EmailPort` (dev in-memory outbox now; worker→SMTP + egress allow-list later) and
  `AdminNotificationPort` (identity-only lockout alert) — `src/auth/ports/`.

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`, **`JWT_SECRET`** (secret — shared with the gateway for local
verify). Tunables with safe defaults (overridable): `ACCESS_TTL`, `SESSION_TTL`, `REMEMBER_TTL`,
`CODE_TTL`, `CODE_LENGTH`, `CODE_MAX_ATTEMPTS`, `LOCKOUT_THRESHOLD`, `LOCKOUT_WINDOW`, argon2 cost.
Validated at boot by [`src/config.ts`](src/config.ts). *(No password-set validator here — set-time
policy lands with feature 010.)*

## Run / test
```bash
npm run test --workspace services/auth      # Track A: hermetic (mock Prisma, in-memory ports, fixed clock)
npm run prisma:migrate:auth                 # Track B only (live auth_db); then npm run seed
```
Runs as part of `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Gotchas
- Codes/passwords/tokens are **never** logged (Principle IV) — the dev EmailPort keeps codes in an
  inspectable outbox object, not the log.
- Does **not** connect to Postgres at boot — a downed DB degrades health, it doesn't crash startup.
- Access-JWT expiry is real-time (`jsonwebtoken`); OTP/refresh/lockout expiry uses the injectable clock.
