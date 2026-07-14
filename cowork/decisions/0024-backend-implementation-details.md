# 0024 — Backend implementation details (NestJS)

**Status:** accepted (accumulating) · **Date:** 2026-07-08 · **Relates:** 0022, 0023

Running record of finer NestJS backend decisions.

## 1. DB access

- **Data:** **Prisma** ORM connecting directly to the Supabase Postgres (transactions, complex queries, migrations).
- **Auth & Storage:** **supabase-js** SDK only (its strong suit).
- **Migrations owned by Prisma** (single source of truth for schema — do not also run Supabase CLI migrations against the same schema, to avoid conflicts).
- Rationale: supabase-js is client/edge-oriented and awkward for heavy server logic; a real ORM is the right tool for backend data access.

## 2. API style

- **REST** as the primary API (matches the existing Vue frontend contract; simpler; AI-fluent; good caching).
- **SSE / WebSocket** for streaming + realtime (LLM reply-suggestion streaming, live chat, typing) — the NestJS WebSocket layer from 0022.
- **No GraphQL** — its flexibility doesn't justify the added complexity/two-paradigm burden for a solo build; streaming is handled by SSE/WS regardless.

## 3. Structure — modular monolith, extract services over time

- Start as a **modular monolith**: one NestJS app, feature modules by domain (conversations, contacts, inboxes, teams, automations, channels, webhooks, reports…).
- **Extract a module into its own microservice only when there's a concrete reason** (independent scaling, different runtime, cost isolation). Prime future candidates: **AI/LLM service**, high-volume channel-webhook ingestion.
- **New features:** default to a **module in the monolith**; spin up a separate service only when the feature is genuinely independent — avoids microservice sprawl.
- Module boundaries are the seam that makes later extraction cheap.
- **Clarification (revisited 2026-07-09):** microservices do **not** make code faster — they add network latency + distributed-systems complexity. They buy *independent scaling / isolation / different runtime*, which we apply **surgically** (prime candidate: the AI/LLM service; workers already run as separate BullMQ processes). Raw performance comes from DB indexing, caching, async work, and list virtualization — see `../performance.md`. Modular monolith stays the default for the MVP.
