# auth

Authentication/identity service. **State:** a bootable **gRPC microservice** exposing
`HealthService.Check` over its **own** Postgres database, with the Phase-2 data model in place.
Auth domain logic (login, JWT issuance, sessions, MFA, RBAC) arrives in **Phase 3**.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50051**) implementing `HealthService.Check`.
- Owns its **own** database `auth_db` via role `auth_user` — no cross-service DB access (Principle VIII).
- Data model (feature 006): `User`, `Credential` (shape-only, no plaintext), `Role`, `UserRole` —
  every tenant table carries an indexed `account_id` seam (ADR 0003). Enforcement (RBAC, MFA) = Phase 3.

## Interfaces
- Owned gRPC contract: [`libs/proto/crm/auth/v1/auth.proto`](../../libs/proto/crm/auth/v1/auth.proto)
  (`AuthService` — bodies implemented in Phase 3) + [`health.proto`](../../libs/proto/crm/health/v1/health.proto).
- DB schema (its own): [`prisma/schema.prisma`](prisma/schema.prisma) → `auth_db`.
- Isolation/provisioning: [`deploy/local/postgres/init/01-init-databases.sh`](../../deploy/local/postgres/init/01-init-databases.sh).

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`. Validated at boot by [`src/config.ts`](src/config.ts) via
`@crm/common` `loadConfig` — missing/placeholder ⇒ exit≠0, before any connection opens.

## Run / test
```bash
npm run test --workspace services/auth
```
Runs as part of `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Gotchas
- Does **not** connect to Postgres at boot — a downed DB degrades health, it doesn't crash startup.
