# Local development environment (Docker Compose)

Spec: [`specs/003-local-infra`](../../specs/003-local-infra/spec.md) · roadmap Phase 1 (1.1–1.5).
Local dev only — production is Kubernetes (Phase 13).

## Run

```bash
cp .env.example .env      # then replace every CHANGE_ME with a real value (services refuse to start otherwise)
docker compose up -d      # postgres + redis + 6 backend services
docker compose ps         # datastores should report healthy
docker compose down -v    # stop everything and drop volumes for a clean reset
```

Web (Next.js) runs separately until Phase 8: `npm run dev:web`.

## Port map

| Surface | Port | Exposure | Purpose |
|---|---|---|---|
| **gateway** REST + WebSocket | **3000** | **host** | single external entry point (US4 / FR-009) |
| web (Next.js dev) | 3001 | host (run outside compose) | frontend dev server |
| postgres | 5432 | host-bound to `127.0.0.1` (optional; for a DB client) | per-service databases |
| redis | 6379 | internal only | cache / queue (BullMQ) |
| auth gRPC | 50051 | internal only | `HealthService.Check` |
| users gRPC | 50052 | internal only | `HealthService.Check` + `PingService` |
| chats gRPC | 50053 | internal only | `HealthService.Check` |
| brands gRPC | 50054 | internal only | `HealthService.Check` |
| worker gRPC | 50055 | internal only | `HealthService.Check` |

Only the gateway (and the separately-run web dev server) are reachable from the host; datastores
and east-west gRPC stay on the internal compose network — mirroring production, where nothing
east-west is publicly reachable. Postgres is bound to `127.0.0.1` for convenience (comment out the
`ports:` block in `compose.yaml` to make it fully internal).

## Databases & isolation

One Postgres engine holds a **separate database + dedicated login role per data-owning service**
(`auth_db`/`auth_user`, `users_db`/`users_user`, `chats_db`/`chats_user`, `brands_db`/`brands_user`),
created by [`postgres/init/01-init-databases.sh`](postgres/init/01-init-databases.sh) from passwords
in `.env`. Each role may `CONNECT` to **only its own** database (`PUBLIC` connect revoked) — the
local realization of DB-per-service isolation (FR-002). `gateway` (stateless routing) and `worker`
(queue-only) own no database.

## Verifying without Docker

The dev box may lack Docker. All startup/config-refusal/health/ping logic is covered by
`npm test` (compose-independent). The live `docker compose up` smoke runs on the `beton-test`
server — see [`quickstart.md`](../../specs/003-local-infra/quickstart.md) Track B.
