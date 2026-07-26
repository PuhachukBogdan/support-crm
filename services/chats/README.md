# chats

Core conversations / ticketing service. **State:** a **gRPC microservice** over its **own** Postgres
exposing `HealthService.Check` plus the **chats-core domain** (feature 012, roadmap 4.1–4.3):
conversations, messages (incl. protected private notes), and the player feed. Routing / assignment /
automations / SLA / audit / uploads / exports (4.4–4.10) and VIP routing (4.11–4.13) are later features.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50053**): `HealthService.Check`, `ChatsReadService`,
  `ChatsWriteService`.
- Owns `chats_db` via role `chats_user` — no cross-service DB access (Principle VIII).
- Tenant data is read/written ONLY via `PrismaService.forAccount(accountId)` (account-scoped,
  fail-closed — feature 007 / Principle I). `brand_id`/`player_id`/`assignee_operator_id`/`author_id`
  and message `mentions[]` are **soft refs** — resolved via gRPC, never joined.
- **RBAC at two tiers:** the gateway `@RequiresPermission` guard **and** this service's
  `ChatsAccessGuard` (reads `x-actor-permissions` from gRPC metadata) both enforce, deny-by-default
  (Principle II / SC-004). Keys reused from the RBAC catalogue: `crm.inbox.view` (reads),
  `crm.conversation.reply` (message posts + status).
- **Caller context rides in gRPC metadata** (`x-actor-account-id/user-id/role/permissions/brands`),
  never in message fields (research R1). Brand scope (`x-actor-brands`) intersects list/feed results;
  singleton reads/writes are brand resource-checked. Absent brands ⇒ no brand filter (Brands service,
  Phase 5).
- **SEC-13 (private notes):** the CUSTOMER thread projection excludes private-note rows **at the
  query** (`private:false`) — they are never loaded or serialised for a customer view (SC-002).

## Interfaces
- gRPC contracts: [`chats.proto`](../../libs/proto/crm/chats/v1/chats.proto) (own) +
  [`health.proto`](../../libs/proto/crm/health/v1/health.proto). Consumes
  [`users.proto`](../../libs/proto/crm/users/v1/users.proto) /
  [`brands.proto`](../../libs/proto/crm/brands/v1/brands.proto) once those read servers land (Phase 5).
- DB schema (its own): [`prisma/schema.prisma`](prisma/schema.prisma) → `chats_db`. Migrations in
  [`prisma/migrations/`](prisma/migrations) (Track B: `prisma migrate deploy`).
- Isolation extension: [`libs/common/src/account-scope.ts`](../../libs/common/src/account-scope.ts).

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`. Validated at boot by [`src/config.ts`](src/config.ts).

## Run / test
```bash
npm run test --workspace services/chats   # Track A (mocked Prisma; no Docker)
npm run seed:chats                         # synthetic seed (Track B, live chats_db)
```
Runs as part of `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Gotchas
- Does **not** connect to Postgres at boot — a downed DB degrades health, doesn't crash startup.
- Keyset pagination only (no offset/COUNT) — `page_size` capped at 100 (default 50). Cursor util:
  [`src/shared/cursor.ts`](src/shared/cursor.ts).
- @mention capture is **write-only** in this feature; existence/notification resolution is deferred
  to the Users read endpoint (Phase 5) — resolution is account-scoped, so an out-of-account id can
  never resolve (research R6).
- tsx/esbuild emits no decorator metadata → every constructor param uses explicit `@Inject`.
