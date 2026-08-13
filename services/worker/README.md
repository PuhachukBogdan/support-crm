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

### `crm-export-run` → `run-due-exports` (feature 017)

The export queue, and the reason there is no queue: **chats has no Redis configuration at all**. Giving it
a queue client, new config keys and a compose edit would buy a few seconds of latency on an operation
measured in minutes, so a request writes a `queued` row and this tick claims it
([`src/jobs/export-run.job.ts`](src/jobs/export-run.job.ts)).

`queued → running` is a **conditional** update, so idempotency again needs no bookkeeping: two overlapping
ticks both try, exactly one wins. 10 s rather than the sweep's 30 — somebody is actively waiting for an
export, unlike a breach nobody is watching.

### `crm-artefact-purge` → `sweep-expired-exports` (feature 017)

**Both halves of expiry from one clock** ([`src/jobs/expiry-sweep.job.ts`](src/jobs/expiry-sweep.job.ts)):
`ChatsMaintenanceService.ExpireDueExports` flips the record and clears its artefact reference;
`UsersMaintenanceService.PurgeExpiredArtefacts` deletes the bytes and the row. Only `users` holds storage
credentials, so only `users` can delete — the worker's contribution is the clock, exactly as for the SLA
sweep.

The two calls are **awaited separately**, so `users` being down does not stop records from expiring, and
either half left undone is simply found again next tick. They must *not* coordinate: neither reads the
other's database (Principle VIII), a two-phase handshake between two services is wrong whenever one of them
is restarting, and both predicates derive from **one** catalogue constant — which is the whole of the
coupling they need.

⚠️ **This job's chats half was missing entirely until Track B.** `ExpireDueExports` was written, hosted,
unit-tested and called by nothing, so every completed export stayed `ready` for ever holding a dangling
`upload_id`. That is 015's live-only defect mirrored — a hosted package with an unwired handler there, a
wired handler with no caller here — and it is now a standing Track A guard:
[`tests/worker/maintenance-ticks.spec.ts`](../../tests/worker/maintenance-ticks.spec.ts) asserts **every**
`*MaintenanceService` RPC is reached from a job. A maintenance RPC is *defined* by having no user-facing
caller, which makes it the one shape of dead code the product cannot notice on its own.

The queue name is `crm-artefact-purge` — unchanged from when this job only did the purge half, because
renaming it would leave the old repeatable entry in Redis with no worker attached, quietly queueing jobs
nobody processes.

## Interfaces
- Serves: [`libs/proto/crm/health/v1/health.proto`](../../libs/proto/crm/health/v1/health.proto).
- Consumes: [`libs/proto/crm/chats/v1/chats.proto`](../../libs/proto/crm/chats/v1/chats.proto) — **only**
  `ChatsMaintenanceService`, with `x-actor-kind: system` metadata. That surface has no gateway route, so
  this is the only way in ([`src/chats/chats.client.ts`](src/chats/chats.client.ts)).
- Consumes: [`libs/proto/crm/users/v1/users.proto`](../../libs/proto/crm/users/v1/users.proto) — **only**
  `UsersMaintenanceService.PurgeExpiredArtefacts`, same system-actor metadata, same absence of a route
  ([`src/users/users.client.ts`](src/users/users.client.ts)). **No raised message ceiling on purpose:** the
  call carries a limit and returns counts, and the bytes are deleted inside `users`, never streamed here.
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

## The channel mailbox and the sender's clock (feature 033, roadmap 6.4/6.5)

Two things live here, and they are different shapes:

**`ImapReaderService` - a PERSISTENT connection, not a tick.** The mailbox *tells* us mail arrived (IMAP
`IDLE`), because the operator asked for real time by name. A BullMQ repeatable job fires once across
replicas, which is right for a tick and meaningless for a socket - every replica would open its own IDLE.
So exactly one replica holds it, decided by a **Redis lease** (`SET NX PX`, renewed).

⚠️ **The lease is an efficiency device, not the correctness device.** At-most-once is
`@@unique([account_id, external_id])` on the message row: if two replicas ever race - a lock expiring
under a long GC pause is the ordinary way - the second insert loses and the customer's message still
appears once. The opposite design ("the lease guarantees single delivery") is how a lock expiry becomes a
duplicated customer message, and it fails in production and never in a test.

⚠️ **The egress guard runs before any socket is opened** (`MAIL_ALLOWED_HOSTS`) - the harm *is* the
connection, so `imap-egress.spec.ts` counts constructions rather than errors.

⚠️ **One poisonous message may never stop the intake.** Every message is handled inside its own `try`; an
unparseable one is refused, counted, marked seen (so a loop is not re-read for ever) and the next is
taken in. A refusal chats calls **retryable** is left UNREAD instead, so the next pass succeeds once the
dependency is back.

**`InboundMailSweepJob` - the safety net, never the delivery path.** For a dropped connection, a process
that died mid-batch, or a message that landed during a restart. It sweeps the reader's **live** connection
rather than opening a second one. Anything it takes in is a message the push path missed, so it logs at
WARN: silence is the healthy state.

**`OutboundTickJob`** says "now" and nothing else. chats holds the outbox, fetches the envelope and opens
the connection; a batch size out, three counts back - never a recipient, a subject or a body.

**`ResolveIntakeChannel`** is asked once per channel key: the worker knows only the key, and uploading a
customer's attachment needs an ACCOUNT. Deliberately not a `CHANNEL_ACCOUNT_ID` env var - a configured
copy of what the `Channel` row states can disagree with it, and the disagreement puts one tenant's files
in another tenant's storage.
