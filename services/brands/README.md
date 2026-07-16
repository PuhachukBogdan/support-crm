# brands

Brandsentication/identity service. **Phase 1 state:** a bootable **gRPC microservice** exposing
`HealthService.Check` over its **own** Postgres database. Brands domain logic (login, JWT issuance,
sessions, MFA, RBAC) arrives in **Phase 3**.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50054**) implementing `HealthService.Check`.
- Owns its **own** database `brands_db` via role `brands_user` — no cross-service DB access (Principle VIII).
- Health probe = Prisma `SELECT 1` (datasource-only schema; models arrive in Phase 2).

## Interfaces
- gRPC contract: [`libs/proto/crm/health/v1/health.proto`](../../libs/proto/crm/health/v1/health.proto).
- DB schema (shared, datasource-only for now): [`prisma/schema.prisma`](../../prisma/schema.prisma).
- Isolation/provisioning: [`deploy/local/postgres/init/01-init-databases.sh`](../../deploy/local/postgres/init/01-init-databases.sh).

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`. Validated at boot by [`src/config.ts`](src/config.ts) via
`@crm/common` `loadConfig` — missing/placeholder ⇒ exit≠0, before any connection opens.

## Run / test
```bash
npm run test --workspace services/brands
```
Runs as part of `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Gotchas
- Does **not** connect to Postgres at boot — a downed DB degrades health, it doesn't crash startup.
