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
- **Domain edges** (thin proxies; each feature's contract lives in its own `specs/*/contracts/gateway-rest.md`):
  `/conversations` + `/players/:id/feed` (chats, 012–014), `/uploads` (016), `/exports` (017),
  `/audit` (015, federated k-way merge), and `/players` + `/operators/:id` (**018**, below).
- **Players + operators read edge (feature 018, roadmap 5.1):** three GETs in
  [`src/players/`](src/players) — `GET /players/:playerId`, `GET /players?brandId=`,
  `GET /operators/:operatorId`. No write route and no fourth route: the customer card is roadmap 9.4.
  Query parsing is **fail-closed** ([`src/players/wire.ts`](src/players/wire.ts)) — `brandId` is
  **required** (defaulting it to "all" is the widening direction in its purest form) and an unknown
  parameter is a 400 that names the KEY and never echoes the value (SEC-26).
- `GET /health` (+ `/health/ready`) and `GET /ping` — unauthenticated infra surfaces (`@Public()`).
- Owns **no database**. Holds a Redis connection for its readiness check + the effective-permission cache.
- **Holds no field-visibility policy.** The edge authorizes the CALL; the owning service shapes the ROW.
  Asserted by `tests/users-read/single-policy-path.spec.ts` — a masking decision here would be a second
  policy in the place least able to know the record.

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
- **⚠️ `req.effective` is populated ONLY for routes carrying permission metadata**, and
  [`buildActorMetadata`](src/chats/actor-metadata.ts) reads exactly that to fill the headers it forwards.
  A route with neither `@RequiresPermission` nor `@ResolvesPermissions` forwards an **EMPTY** permission
  set, and the owning service then correctly refuses everything — both tiers individually right, the wire
  between them wrong. Feature 016 shipped that defect to a live run; every uploads and players route now
  carries metadata of one kind or the other, asserted over a route list **derived from the controller**
  (016's own version enumerated three names by hand, so a fourth route would have slipped through).
- **Three actor headers, three different meanings** — do not consolidate them:
  `x-actor-role` = who the caller **is**; `x-actor-effective-role` = who they are **acting as** (the
  masking input, and the *previewed* role under view-as); `x-is-preview` = whether a preview is active.
  ⚠️ `x-is-preview` had a builder parameter from feature 012 that **no route ever passed**, so until 018
  every audit entry in the product recorded "no preview" regardless of the truth. The two newer headers
  were added **additively** rather than by repurposing `x-actor-role`, because changing a header's meaning
  is the kind of change nothing fails on.

## The `/me/*` family — edges gated by NO permission, and why that is the design

Two edges answer questions whose subject is the CALLER and can be nobody else. Neither checks a
permission; both still require a session (the global AuthGuard), and both make the isolation
guarantee structural: no path segment, no query and no body could name another person, so
`/operators/:id/…` fails a planted-input structural test rather than passing review.

**`GET /me/operator` (roadmap 5.11, MVP block W5)** — "which operator am I?" Forwards to W1's
`EnsureOwnOperator` in `users` (idempotent; the write branch is practically dead because the login
tail already ensured the profile — and if it fires it repairs). This is the translation the browser
cannot do itself: assignments point at `Operator.id`, the session carries only the auth identity.
"Your work" and the agent rail stand on it. The response is restated field by field, so an rpc field
added later does not silently reach the browser.

## `/me/ui-preferences` (feature 021, roadmap 5.6)

`GET` and `PATCH`, forwarding to `OperatorUiPreferencesService` in `users`. The operator's own theme
and font-size step. **Not** `Player.preferences_json`, which is customer data.

- **`/me`, never `/operators/:id/…`** — the isolation guarantee is the ABSENCE of a parameter, not a
  check. With `/me` there is no path segment that could name another person, so a later
  `/operators/:id/ui-preferences` fails a structural test rather than passing review.
- **`PATCH`, not `PUT`** — the body is a partial set of keys, and `PUT` would advertise whole-record
  replacement. `PATCH` is in the guard's mutating set, which is what makes the view-as write-block
  apply.
- **Shape validation only.** Whether a key exists and whether a value is allowed is the owning
  service's decision against the closed catalogue (Principle II). A second copy of those rules here is
  the drift feature 017 found live, where two export vocabularies had already diverged. A spec asserts
  this edge names no preference key at all.
- **⚠️ Both routes carry `@ResolvesPermissions()` and no `@RequiresPermission`** — and that is the one
  decision in the folder. The view-as write-block runs for every route with claims, so `PATCH` under a
  preview is already refused here; but `req.effective` is populated only for routes with permission
  metadata, and `x-is-preview` comes from exactly that. Without the decorator the owning service's
  independent refusal becomes unreachable **with every test green**, because this tier already covers
  the case. The decorator itself is pinned by a test, over a route list derived from the controller.
- **Not "no authorization"**: the global AuthGuard still requires a session. What is absent is a
  *permission* check, because no permission gates a person's own font size (ADR 0035's hard boundary).

## The channel intake route (feature 033, roadmap 6.1)

`POST /channels/:key/inbound` - `@Public()`, and the only public write route in the product.

**The gateway's entire job here is routing:** preserve the raw bytes, pass them plus the signature header
and the channel key to chats, map the outcome to a status code. No parsing, no validation, no business
logic - it holds no channel secret and performs no verification.

⚠️ **`NestFactory.create(AppModule, { rawBody: true })` is a bootstrap change this route depends on.** A
signature is over bytes; parse-then-re-serialise produces a different byte string and **every** signature
fails - and the symptom reads as *"the provider signs wrongly"*. `channels/raw-body.spec.ts` asserts a
byte-exact round trip.

| Outcome | Status |
|---|---|
| accepted, durable before the response | `202` |
| already accepted (a replay) | `200` - **not** an error, or the provider retries for ever |
| signature absent, malformed or not verifying; outside the replay window | `401` |
| unknown **or disabled** channel key | `404` - the same shape for both, so a retired key is not confirmable |
| no derivable event id; missing what a ticket needs | `422` |

`GET /conversations/channel-capabilities` is the authenticated counterpart (`crm.inbox.view`), kept under
`/conversations` on purpose: hanging an authenticated read off `/channels/...` would put two different
authentication stories under one path.

## The realtime edge (feature 034, MVP block W4)

`ws/realtime.gateway.ts` — **one** WebSocket gateway class, on the explicit path **`/ws`**, and the count
is the contract: sockets are matched by path, so a second `@WebSocketGateway` class on the same path is a
coin toss over which one the adapter binds (measured — the handshake died with `handleConnection` never
running). `ws/ws-path.spec.ts` fails the build on a second class or a bare decorator.

- **Authorization happens at the handshake**, with the same `verifyAccessToken` the HTTP `AuthGuard` uses —
  extracted, not copied. ⚠️ The global guard passes every non-HTTP context through by design, so this
  gateway is the *only* authorization the socket surface has. No cookie ⇒ `close(1008)`, never
  open-but-silent.
- **Rooms are the account from the token.** There is no frame vocabulary for joining anything — the one
  `@SubscribeMessage` is `ping` (spec 003's same-port proof), and it names no tenant.
- **The frame is the published payload unchanged** (`parseRealtimeEvent` drops unknown fields): the gateway
  enriches nothing, holds no chats client on this path, and stays a fan-out rather than a read path.
- Subscribes per account on the first socket, unsubscribes on the last; the subscriber is a `duplicate()`d
  Redis connection (a client in subscribe mode may not run commands).
- ⚠️ **Deployment — three things, and all three failed once each.** Whatever fronts the app must:
  1. route `/ws` on the **SAME ORIGIN as the page** — a cookie-authenticated socket cannot be cross-origin
     (`SameSite=Lax` is not sent on a cross-site upgrade; `SameSite=None` requires `Secure`+https);
  2. **exempt `/ws` from any basic-auth**, because browsers send no basic credentials on an upgrade, so the
     lock answers 401 and every socket dies. This is not a weakening: the handshake check above already
     refuses a cookie-less socket with 1008, measured on the public origin;
  3. be able to **reach this container** — `/ws` cannot be proxied through Next.js, so it goes straight to
     the gateway, which is why `compose.yaml` puts the gateway on the shared `edge` network as well as
     `default`. ⚠️ Both, not just `edge`: in compose a `networks:` key **replaces** the implicit default
     membership, and dropping it costs every gRPC target and Redis by name.

  Symptoms are indistinguishable from one another at the browser (a socket that never delivers): 401 from
  the lock, 502 with the container off `edge`. `tests/integration/local-infra/proxy-reachable-containers-keep-both-networks.spec.ts`
  guards (3); the stand's Caddyfile carries the worked example of (1) and (2), with the reasoning inline.

Canonical sources: `libs/common/src/realtime/events.ts` (the event contract and why it carries no content),
`specs/034-realtime-fanout/spec.md`, `deploy/local/live-w4.sh`.
