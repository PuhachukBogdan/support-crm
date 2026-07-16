# gateway

The system's **single ingress** and API edge. Serves **REST + WebSocket on one host/port** and is
a **gRPC client** of the backend services. Routing/edge only — **no business logic** (Principle VIII);
JWT validation + RBAC routing arrive in Phase 3.

## Responsibility & boundaries
- Exposes the only host-reachable surface (`GATEWAY_PORT`, default 3000): REST + WS.
- `GET /health` — liveness (unauthenticated; probe target).
- `GET /health/ready` — **readiness aggregate**: fans `HealthService.Check` out to all backend
  services over gRPC (bounded deadline) + checks its own Redis → one DTO, 503 if any degraded.
- `GET /ping?message=` — cross-service round-trip to `users` over gRPC (US3); 503 if downstream down.
- Owns **no database**. Holds a Redis connection for its own readiness check.

## Interfaces
- gRPC **client** of: `auth`, `users`, `chats`, `brands`, `worker` (health) + `users` (ping).
  Contracts: [`libs/proto/crm/health/v1/health.proto`](../../libs/proto/crm/health/v1/health.proto),
  [`libs/proto/crm/ping/v1/ping.proto`](../../libs/proto/crm/ping/v1/ping.proto).
- Dial targets + port map: [`.env.example`](../../.env.example) / [`deploy/local/README.md`](../../deploy/local/README.md).

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GATEWAY_PORT`, `REDIS_URL`, `{AUTH,USERS,CHATS,BRANDS,WORKER}_GRPC_TARGET`. Validated at
boot by [`src/config.ts`](src/config.ts) via `@crm/common` `loadConfig` — missing/placeholder ⇒ exit≠0.

## Run / test
```bash
npm run start:gateway          # from repo root (needs env set / compose)
npm run test --workspace services/gateway
```
Full stack: `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Gotchas
- Readiness never hangs on a downed dependency (rxjs `timeout`) and never crashes (probes swallow errors).
- WS uses the native `ws` adapter so REST + WS share the one HTTP server/port.
