# brands

White-label brand / multi-tenancy service. **State:** a bootable **gRPC microservice** exposing
`HealthService.Check` over its **own** Postgres database, with the Phase-2 data model in place.
Brand-scoped access enforcement (who reads/answers which brand) arrives in **Phase 5**.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50054**) implementing `HealthService.Check`.
- Owns its **own** database `brands_db` via role `brands_user` — no cross-service DB access (Principle VIII).
- Data model (feature 006): `Brand` (tenant-scope data, never hardcoded identity — Principle VI) +
  `BrandAccessRule` (ADR 0003 access seam; `operator_id` is a soft ref, no cross-service FK). Every
  tenant table carries an indexed `account_id`.
- Isolation (feature 007): tenant data is read/written ONLY via `PrismaService.forAccount(accountId)`
  (account-scoped client; fail-closed) — see [`libs/common/src/account-scope.ts`](../../libs/common/src/account-scope.ts).
  Raw `$queryRaw` (health `SELECT 1`) bypasses scoping — an audited escape hatch (no tenant data).

## Interfaces
- Owned gRPC contract: [`libs/proto/crm/brands/v1/brands.proto`](../../libs/proto/crm/brands/v1/brands.proto)
  (`BrandsReadService` — bodies in Phase 5) + [`health.proto`](../../libs/proto/crm/health/v1/health.proto).
- DB schema (its own): [`prisma/schema.prisma`](prisma/schema.prisma) → `brands_db`.
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
