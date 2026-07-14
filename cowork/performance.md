# Performance — optimization instructions

> First-class concern. The system holds a **large ticket history (100k+ / hundreds of thousands)** and dozens of concurrent agents, so performance is designed in, not bolted on. Claude Code consults this doc for any data-heavy or list/query work.

## Guiding principle
Performance comes from **good data access, caching, async work, and rendering discipline** — NOT from splitting into microservices. Keep the modular monolith (decision 0024); extract a component into its own service only when metrics show a real need (independent scaling / isolation), e.g. the AI service or high-volume ingestion.

## Database (Postgres via Prisma)
- **Indexes** on every high-cardinality / frequently-filtered column: `account_id` (tenant scope, on all tenant tables), ticket `status`, `assignee_id`, `team_id`, `inbox_id`, `created_at`/`updated_at`, contact `email`/`player_id`, labels. Composite indexes matching real query filters (e.g. `(account_id, status, updated_at)`).
- **Keyset / cursor pagination** for large lists (ticket lists, history) — never `OFFSET` on big tables.
- **No N+1**: use Prisma `select`/`include` deliberately; fetch only needed fields; batch related loads.
- **Count carefully**: exact `COUNT(*)` on huge tables is slow — use approximate counts or cached counters for badges.
- **Connection pooling** (PgBouncer/Supabase pooler); tune pool size.
- Heavy reads for analytics run on aggregates, not row scans (materialized views / pre-aggregation where needed).

## Caching (Redis)
- Cache hot, rarely-changing data (settings, macros, canned responses, label lists, user/role lookups).
- Cache expensive computed values (unread counters, dashboard aggregates) with sensible TTL + invalidation on write.

## Async & background (BullMQ)
- Offload anything slow or non-interactive from the request path: notifications, exports, webhooks, email send, LLM calls, migrations, scheduled cleanups.
- Idempotent jobs, retries with backoff, dead-letter handling.

## API
- Paginate every list endpoint; enforce max page size.
- Return lean DTOs (only fields the UI needs); avoid over-fetching.
- Rate-limit high-volume write endpoints.

## Realtime
- Scope WebSocket broadcasts to the relevant account/inbox/agents only — don't fan out globally.
- Never send private activity to customer connections (also a security invariant).

## Frontend (Vue)
- **Virtualize long lists** (ticket list, message thread) with TanStack Virtual — render only visible rows.
- Lazy-load routes and heavy components; code-split.
- Debounce search/filter input; cancel stale requests.
- Memoize derived data; avoid re-render storms; keep Pinia stores lean.
- Optimize assets (image sizes, avoid heavy animations in dense views — see UI decisions).

## Budgets (targets to hold)
- Inbox list first paint fast even at 100k+ tickets (via keyset pagination + virtualization).
- API p95 latency modest for common reads; slow paths go async.
- Set and watch these; a regression in a budget is a bug.

## When to extract a service (not before)
Extract only with a concrete driver: independent scaling, isolation, different runtime/cost profile. Prime candidates: **AI/LLM service**, high-volume channel **ingestion**, (workers already run as separate BullMQ processes). Module boundaries in the monolith make later extraction cheap.
