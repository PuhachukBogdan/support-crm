# 0022 — PIVOT: no Ruby → rewrite backend in NestJS; Chatwoot becomes a blueprint

**Status:** accepted · **Date:** 2026-07-08 · **Supersedes:** 0001, 0009, 0010, 0011, 0013 · **Driver:** tech lead — **no one on the team can maintain Ruby**

## The change

Ruby is ruled out (no maintainers — same maintainability logic the whole project rests on). This **overturns the foundational decision 0001** (keep Rails). Consequence: we **no longer fork Chatwoot's backend**. We **rewrite the backend in TypeScript / Node (NestJS)**, and Chatwoot becomes a **reference/blueprint**, not a code base.

Honest magnitude: this is a **substantially larger effort than adapting** — effectively a multi-month backend build. The time-savings Chatwoot offered were concentrated in its Rails backend; for the backend, that saving is largely gone. This is the real cost of the "no Ruby" constraint.

## What we picked

- **Backend:** NestJS (TypeScript). NestJS chosen for one-language stack with the Vue frontend + closest structural match to Rails (modules/DI/layers) to ease porting patterns.
- **Frontend:** **KEEP Vue** — the team maintains Vue (Option 1). React/shadcn rejected: going React would repeat the exact "no one to maintain it" mistake. Design uses **shadcn-vue** (0002 holds, reinforced).
- **What we salvage from Chatwoot:** the **Postgres DB schema** (89 tables — language-independent, used as the data-model blueprint, also eases future Zendesk migration), the **Vue frontend** (rewrite only its thin API-client layer to talk to the new backend), and Chatwoot's **behavior + RSpec specs as a specification** of what the backend must do.

## Component mapping (Rails → TS stack)

- Sidekiq (jobs) → **BullMQ** (Redis-backed).
- ActionCable (realtime) → **WebSocket** (Socket.IO / ws).
- Devise (auth) → **Supabase Auth (GoTrue)** per 0023; NestJS validates Supabase JWTs (was Passport/JWT).
- ActiveStorage (files) → **S3-compatible + multer** (or equivalent).
- RSpec → **Jest/Vitest** as the running test gate; Chatwoot's RSpec kept as **reference behavior spec**.

## Cascade — decisions affected

**Superseded / void:**
- **0001** keep Rails → superseded (NestJS backend).
- **0009** full clone + Devise → superseded: this repo is a **new NestJS+Vue project** (not a whole-repo clone); `../chatwoot` remains untouched reference; auth rebuilt.
- **0010** Rails 8.1 upgrade → **void** (no Rails).
- **0011** RSpec CI gate → superseded: TS tests are the gate; RSpec kept as reference spec.
- **0013** rebrand code → **void**: new codebase is ours from the start, named as we choose.
- **0012** remove enterprise → moot: we ship none of Chatwoot's code; enterprise stays reference-only in `../chatwoot`.

**Held (language-independent):**
- **0002** Vue frontend (reinforced), **0003** single-tenant + seam (re-implemented in our schema), **0004** own RBAC (built in NestJS), **0005** web, **0006** scope, **0007** Postgres+Redis+Docker (+ reuse schema as blueprint), **0008** AI deferred, **0021** product features.

**Security (0014–0020) — character change:** we now **build security in from the start** rather than patch Chatwoot's bugs. Rails-specific findings (SEC-1 direct_uploads, SEC-2 Devise super-admin, SEC-8 Rails EOL, etc.) become **"do not reintroduce"** requirements in the rewrite; SEC-8 is void. The security **principles/invariants** (tenant isolation, RBAC, SSRF protection, PII-out-of-logs, audit log, backups, egress) fully apply to the new NestJS backend. Silver lining: fewer bugs to patch, because we own the code from line one.

## Base re-validated

With the backend gone, we re-checked whether Chatwoot is still worth using as the base. **Yes:** the salvage is still substantial — the Vue frontend (984 components), the proven Postgres schema, and the feature/behavior blueprint. The base decision holds; no reason to switch to a different foundation.

## Still to settle later

- Frontend API-client layer rewrite approach (keep Vue UI, repoint to new API).
- Exact schema adaptations as we port to TypeORM/Prisma/Drizzle (ORM choice — a future backend sub-decision).
- Whether NestJS is confirmed by the tech lead (recommended; open to his specific TS framework preference).
