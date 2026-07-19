# chats

Core conversations / ticketing service. **State:** a bootable **gRPC microservice** exposing
`HealthService.Check` over its **own** Postgres database, with the Phase-2 data model in place.
Conversation/message domain logic arrives in **Phase 4**.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50053**) implementing `HealthService.Check`.
- Owns its **own** database `chats_db` via role `chats_user` — no cross-service DB access (Principle VIII).
- Data model (feature 006, Chatwoot as blueprint): `Conversation` (the ticket — reserves
  `category`/`sub_category`/`classified_by` per ADR 0027 + the `player_id` feed key, all nullable),
  `Message` (`private`-note flag reserved), `Label`/`ConversationLabel`, `Macro`, `Automation`.
  `brand_id`/`player_id`/`assignee_operator_id` are **soft refs** (resolved via gRPC, never joined).
- Consumes (Phase 4+): `UsersReadService` + `BrandsReadService` — reads players/brands over gRPC,
  never via a DB join. Owns no read-contract of its own in this slice.
- Isolation (feature 007): tenant data is read/written ONLY via `PrismaService.forAccount(accountId)`
  (account-scoped client; fail-closed) — see [`libs/common/src/account-scope.ts`](../../libs/common/src/account-scope.ts).
  Raw `$queryRaw` (health `SELECT 1`) bypasses scoping — an audited escape hatch (no tenant data).

## Interfaces
- gRPC contract: [`libs/proto/crm/health/v1/health.proto`](../../libs/proto/crm/health/v1/health.proto)
  (consumes [`users.proto`](../../libs/proto/crm/users/v1/users.proto) / [`brands.proto`](../../libs/proto/crm/brands/v1/brands.proto) in Phase 4).
- DB schema (its own): [`prisma/schema.prisma`](prisma/schema.prisma) → `chats_db`.
- Isolation/provisioning: [`deploy/local/postgres/init/01-init-databases.sh`](../../deploy/local/postgres/init/01-init-databases.sh).

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`. Validated at boot by [`src/config.ts`](src/config.ts) via
`@crm/common` `loadConfig` — missing/placeholder ⇒ exit≠0, before any connection opens.

## Run / test
```bash
npm run test --workspace services/chats
```
Runs as part of `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Gotchas
- Does **not** connect to Postgres at boot — a downed DB degrades health, it doesn't crash startup.
