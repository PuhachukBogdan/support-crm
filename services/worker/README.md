# worker

Background-jobs service. **Phase 1 state:** a bootable **gRPC microservice** exposing
`HealthService.Check` over its **Redis** connection (via BullMQ). Real job producers/consumers
(notifications, exports, webhooks, email, LLM, migrations) arrive in **Phase 7**.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50055**) implementing `HealthService.Check`.
- Connects to the shared Redis via **BullMQ** (a `crm-health` queue on a shared ioredis connection).
- Owns **no** relational database.

## Interfaces
- gRPC contract: [`libs/proto/crm/health/v1/health.proto`](../../libs/proto/crm/health/v1/health.proto).
- Redis connection: [`src/queue/redis.service.ts`](src/queue/redis.service.ts).

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `REDIS_URL`. Validated at boot by [`src/config.ts`](src/config.ts).

## Run / test
```bash
npm run test --workspace services/worker
```
Runs as part of `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Gotchas
- Redis connection is lazy + non-fatal (`error` swallowed) — a downed Redis degrades health, not startup.
- BullMQ requires `maxRetriesPerRequest: null` on its connection (set in `redis.service.ts`).
