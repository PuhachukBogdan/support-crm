# gateway

The system's **single ingress** and API edge. Serves **REST + WebSocket on one host/port**, is a
**gRPC client** of the backend services, and is the **session edge** (feature 009). Routing/edge only
— **no business logic** (Principle VIII); credential/code/token decisions belong to the auth service.

## Responsibility & boundaries
- Exposes the only host-reachable surface (`GATEWAY_PORT`, default 3000): REST + WS.
- **Session edge (feature 009):** `POST /auth/login`, `POST /auth/verify`, `POST /auth/refresh`
  (public), `POST /auth/logout`, `GET /auth/me` (session-bearing). Translates the `AuthService` gRPC
  surface into REST + **httpOnly `access`/`refresh` cookies** (Secure, SameSite=Lax; ~1d, ~7d with
  remember-me). A **global `AuthGuard`** protects every route unless `@Public()` — it verifies the
  access JWT **locally** (shared `JWT_SECRET`, no per-request gRPC/DB hop; Principle VII) and fails
  closed with 401. Baseline **CSP** via helmet (SEC-12; directives named in `src/security/csp.ts`).
- **Account-lifecycle edge (feature 010):** `POST /auth/activate/request` + `/auth/activate/complete`
  (public, super-admin whitelist onboarding), `POST /auth/invites` (**guarded** — inviter identity
  from the validated claims, never the body), `POST /auth/register/start` + `/auth/register/complete`
  (public). Forwards to `AuthService`; sets the session on activation/registration success; maps
  weak-password → **422**, hierarchy → **403**, rate-limit → **429**, other auth failures → **401**.
- **RBAC edge (feature 011):** a `PermissionGuard` + `@RequiresPermission('key')` decorator enforce
  per-route permissions — it resolves the caller's effective set from a **Redis projection**
  (`EffectivePermsCache`), calling `AuthService.ResolveEffectivePermissions` only on a cache miss and
  invalidating on any change (the JWT carries roles, not permissions — R-1); missing permission → 403.
  **Access-Management REST** (`/admin/access/*`, super-admin-gated) proxies role/permission
  management to auth (catalogue/defaults reads; personalize user/group/role + reset + assign-role
  writes; cross-role group → 409, `super_admin` via UI → 403). **View-as preview** (`POST`/`DELETE
  /admin/view-as`, requires `platform.view_as`) sets a transient Redis-backed preview context; while
  active, reads are shaped to the previewed role and **every mutating request is refused (403)** —
  strictly read-only (SC-009). See `src/security/` + `src/rbac/` + `src/auth/view-as.controller.ts`.
- `GET /health` (+ `/health/ready`) and `GET /ping` — unauthenticated infra surfaces (`@Public()`).
- Owns **no database**. Holds a Redis connection for its readiness check + the effective-permission cache.

## Interfaces
- gRPC **client** of: `auth` (full `AuthService` — login/verify/refresh/logout/validate), plus
  `auth`/`users`/`chats`/`brands`/`worker` health + `users` ping. Contracts:
  [`auth.proto`](../../libs/proto/crm/auth/v1/auth.proto),
  [`health.proto`](../../libs/proto/crm/health/v1/health.proto),
  [`ping.proto`](../../libs/proto/crm/ping/v1/ping.proto).
- Cookie/guard/CSP behavior: [`src/auth/`](src/auth) + [`src/security/csp.ts`](src/security/csp.ts);
  contracts in `specs/009-auth-core-sessions/contracts/gateway-rest.md` +
  `specs/010-account-onboarding/contracts/gateway-rest.md`.

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GATEWAY_PORT`, `REDIS_URL`, `{AUTH,USERS,CHATS,BRANDS,WORKER}_GRPC_TARGET`, **`JWT_SECRET`**
(shared with auth for local verify). Tunable: `ACCESS_TTL`/`SESSION_TTL`/`REMEMBER_TTL` (cookie maxAge),
`COOKIE_SECURE` (default `true`; `false` only for local plain-HTTP dev). Validated at boot by
[`src/config.ts`](src/config.ts) via `@crm/common` `loadConfig` — missing/placeholder ⇒ exit≠0.

## Run / test
```bash
npm run start:gateway          # from repo root (needs env set / compose)
npm run test --workspace services/gateway
```
Full stack: `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Gotchas
- Readiness never hangs on a downed dependency (rxjs `timeout`) and never crashes (probes swallow errors).
- WS uses the native `ws` adapter so REST + WS share the one HTTP server/port.
