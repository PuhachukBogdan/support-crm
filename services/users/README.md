# users

User directory / profiles service. **Phase 1 state:** a bootable **gRPC microservice** hosting two
packages — `HealthService.Check` (over its own Postgres) and `PingService` (the cross-service
round-trip target for US3). Users domain logic arrives in **Phase 5**.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50052**) implementing `HealthService.Check` **and**
  `PingService.Ping` (echoes the message, stamps `servedAt` — proves the value crossed the wire).
- Owns its **own** database `users_db` via role `users_user` (Principle VIII isolation).
- Health probe = Prisma `SELECT 1` (datasource-only schema; models arrive in Phase 2).

## Interfaces
- gRPC contracts: [`health.proto`](../../libs/proto/crm/health/v1/health.proto),
  [`ping.proto`](../../libs/proto/crm/ping/v1/ping.proto).
- DB schema (shared, datasource-only): [`prisma/schema.prisma`](../../prisma/schema.prisma).

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
