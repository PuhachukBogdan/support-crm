# users

User directory / profiles service. **State:** a bootable **gRPC microservice** hosting two
packages — `HealthService.Check` (over its own Postgres) and `PingService` — with the Phase-2 data
model + the Player read path in place. Users domain gRPC (`UsersReadService`) arrives in **Phase 5**.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50052**) implementing `HealthService.Check` **and**
  `PingService.Ping` (echoes the message, stamps `servedAt` — proves the value crossed the wire).
- Owns its **own** database `users_db` via role `users_user` (Principle VIII isolation).
- Data model (feature 006): `Operator`; `Player` ("Player-lite", ADR 0032 §0.1) keyed by `player_id`,
  unified across 1..N brands via the `PlayerBrand` edge (soft `brand_id`, no cross-service FK), with an
  **opaque** GR8-cache seam (`gr8_snapshot`/`gr8_fetched_at`/`gr8_stale` — GR8's typed projection is 7.4).
- Read path: [`src/player/player.repository.ts`](src/player/player.repository.ts) `getPlayerById(accountId, playerId)`.
- Isolation (feature 007): tenant data is read/written ONLY via `PrismaService.forAccount(accountId)`
  (account-scoped client; fail-closed) — see [`libs/common/src/account-scope.ts`](../../libs/common/src/account-scope.ts).
  The player-union (brands) is preserved under scope — the brand carve-out is brand-level, never
  account-level. Raw `$queryRaw` (health `SELECT 1`) is an audited escape hatch (no tenant data).

## Interfaces
- Owned gRPC contract: [`libs/proto/crm/users/v1/users.proto`](../../libs/proto/crm/users/v1/users.proto)
  (`UsersReadService` — bodies in Phase 5) + [`health.proto`](../../libs/proto/crm/health/v1/health.proto),
  [`ping.proto`](../../libs/proto/crm/ping/v1/ping.proto).
- DB schema (its own): [`prisma/schema.prisma`](prisma/schema.prisma) → `users_db`.

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`. Validated at boot by [`src/config.ts`](src/config.ts).

## Run / test
```bash
npm run test --workspace services/users
```
Runs as part of `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Gotchas
- Hosts two gRPC packages from one microservice (`package`/`protoPath` arrays in `main.ts`).
- Does **not** connect to Postgres at boot — a downed DB degrades health, not startup.
