# worker

Background-jobs service. **State:** a **gRPC microservice** exposing `HealthService.Check` over its
**Redis** connection (via BullMQ), plus its **first real job** — the first-reply SLA sweep (feature 014,
roadmap 4.7). The full job catalogue (notifications, exports, webhooks, email send, scheduled cleanups,
dead-lettering) is roadmap **7.3** and is not built yet.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50055**) implementing `HealthService.Check`. The worker exposes
  no domain surface — it is a client, not an API.
- Connects to the shared Redis via **BullMQ** (a `crm-health` queue plus the `crm-sla-sweep` queue on a
  shared ioredis connection).
- **Owns no relational database**, and should not gain one: data belongs to the service that owns it and
  the worker reaches it over gRPC (Principle VIII).
- **Makes no domain decisions.** For the SLA it fires a tick and asks chats to sweep; *chats* decides what
  counts as a breach, marks the row and runs any rules. Keeping the verdict in the owning service is what
  lets the whole decision path be unit-tested there, with the worker contributing only scheduling.

## Jobs

### `crm-sla-sweep` → `first-reply-sweep` (feature 014)

A **repeatable** BullMQ job calling `ChatsMaintenanceService.SweepFirstReplySla` with a system actor
([`src/jobs/sla-sweep.job.ts`](src/jobs/sla-sweep.job.ts)).

Why a repeatable tick rather than a delayed job per conversation — the reasoning matters because the
alternative fails *silently*:

- **Postgres is the source of truth**; Redis holds one repeatable-job definition. A Redis flush or a
  restart costs at most one tick of latency. With a timer per clock, a lost job means a breach that is
  **never** detected — and since nobody is waiting on a breach, no request fails and nobody notices.
- **Idempotency is free.** Marking a row breached removes it from the sweep predicate, so an overlapping
  or retried tick finds nothing. No dedup bookkeeping to get wrong.
- **No cancellation path.** A reply stops the clock by updating the same row; nothing has to hunt down a
  scheduled job.
- **Fires once across replicas.** A `setInterval` inside chats would fire once per pod.

Accepted cost: detection latency is bounded by the interval (default 30 s), not exact — well inside a
target measured in minutes. Test boxes use a few seconds so a breach is observable while watching.

A fixed `jobId` keeps re-registration idempotent; without it every boot would add another repeatable
entry and the sweep would run N times per interval.

## Interfaces
- Serves: [`libs/proto/crm/health/v1/health.proto`](../../libs/proto/crm/health/v1/health.proto).
- Consumes: [`libs/proto/crm/chats/v1/chats.proto`](../../libs/proto/crm/chats/v1/chats.proto) — **only**
  `ChatsMaintenanceService`, with `x-actor-kind: system` metadata. That surface has no gateway route, so
  this is the only way in ([`src/chats/chats.client.ts`](src/chats/chats.client.ts)).
- Redis connection: [`src/queue/redis.service.ts`](src/queue/redis.service.ts).

## Config (refuse-to-start, SEC-6)

| Key | Notes |
|---|---|
| `NODE_ENV`, `GRPC_URL`, `REDIS_URL` | required |
| `CHATS_GRPC_TARGET` | **required** — a worker that cannot reach chats cannot sweep, and failing loudly at boot beats a silently non-sweeping worker |
| `SLA_SWEEP_INTERVAL_MS` | optional, default `30000`, clamped to `[1000, 3600000]` |
| `SLA_SWEEP_BATCH` | optional, default `500`, clamped to `[1, 5000]` |

Validated at boot by [`src/config.ts`](src/config.ts). The two knobs are tuning values, not secrets:
nonsense is clamped rather than fatal, so a bad value can never turn the sweep into a hot loop.

## Run / test
```bash
npm run test --workspace services/worker   # Track A (BullMQ mocked; no Docker, no Redis)
```
Runs as part of `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)). To
watch the sweep on a test box: `SLA_SWEEP_INTERVAL_MS=5000` + `docker compose logs -f worker`.

## Gotchas
- Redis connection is lazy + non-fatal (`error` swallowed) — a downed Redis degrades health, not startup.
- BullMQ requires `maxRetriesPerRequest: null` on its connection (set in `redis.service.ts`).
- **A breach is the one event nobody is waiting for.** If the sweep job never registers, registers twice,
  or dies on the first error, no request 500s and no user complains — the SLA simply stops working. That
  is why the scheduling contract (one registration, stable job id, non-fatal failures) has its own tests
  rather than being left to review.
- Only **counts** cross the boundary from chats (`checked` / `breached` / `rulesApplied`) — never ids. Worker
  logs are therefore safe by construction, with no PII to scrub (Principle IV).
- No outbound/external network calls exist here yet. When they arrive (email, webhooks — 7.3) they must go
  through the SSRF-protecting egress path and the allow-list (Principle III / roadmap 12.5).
