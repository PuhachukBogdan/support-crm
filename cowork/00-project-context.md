# Project Context — Read This First

> **Purpose of this file:** a resume/handoff point. If you are a new chat or a different account, read this before anything else — it captures what this project is, where we are, and every decision already locked, so we don't re-litigate settled questions. Keep it updated as decisions land.
>
> Last updated: 2026-07-13 (28 decisions; `/cowork` docs restructured — see folder map at the bottom and `decisions/README.md`).

> ## ⚠️ MAJOR PIVOT (0022) — read first
> **Ruby is ruled out** (tech lead: no one can maintain it). The project is **no longer a Chatwoot fork**. We **rewrite the backend in TypeScript / NestJS**; Chatwoot is now a **blueprint/reference**, not a code base. We **keep the Vue frontend** (team maintains Vue) and **reuse Chatwoot's Postgres schema** as the data-model blueprint. Honest magnitude: this is a **multi-month backend build**, much larger than the original "fork and adapt." Superseded/void: **0001, 0009, 0010, 0011, 0013** (and 0012 moot). See `decisions/0022`.
>
> **DB/auth platform (0023):** **self-hosted Supabase** — Postgres + Auth + Storage; NestJS is the brain/API/security boundary; auto-API not exposed; RBAC (0004) layers on Supabase Auth. 5 security guardrails apply. Chosen because the build is effectively **solo + AI**, where Supabase's convenience is a real productivity multiplier. Also updates 0004/0007/0022.

## What we're building

Reworking the open-source **Chatwoot** codebase into our own **internal CRM**. Cowork is used for planning/architecture/documentation; Claude Code will later implement from the docs we produce here.

## Workspace layout

- **This repo (root)** = the product; on disk `…\\crm-foundation\\code\\crm`. Contains `CLAUDE.md`, `cowork/` (docs), and the code (`api/`, `web/` — scaffolded in Phase 0). Claude Code opens here; `git init` here.
- `../chatwoot` — cloned Chatwoot **v4.15.1**, **OUTSIDE this repo**. Reference only ("шпаргалка"), never modified.
- `../design-lab` — throwaway design bake-off, **OUTSIDE this repo**.
- `cowork/` — all our project documentation (inside this repo).
- `cowork/reference/chatwoot-security-report.md` — an external security review of Chatwoot. **Input, not truth.**

## Locked decisions (do not re-discuss without a reason)

1. **Chatwoot is a disposable scaffold, not a base.** We take only pieces that already suit us (e.g. chat window, manager registration), rework them under our own code, and eventually discard Chatwoot entirely. Our product vision outranks Chatwoot in every conflict.
2. **No dependency on Chatwoot** — no subscriptions, no Enterprise license, no shipping their paid code. → the Enterprise-license blocker (SEC-33) and the "conversations sent to a third-party LLM" concern (SEC-C1) are **dissolved**: we won't inherit their AI agent, and anything we keep gets rewritten as our own.
3. **One-time copy, no upstream link (variant Б).** We will not pull future Chatwoot patches. The entire security-patch lifecycle (framework, dependencies) is permanently ours.
4. **No inherited features by default.** No ready AI agent, no ready DB. We build our own AI and DB *only if/when needed*. A Chatwoot feature is in our product only if it earns its place.
5. **Bugs are fixed at the code stage.** `security/findings.md` doubles as the rework/rewrite checklist for whatever we borrow from Chatwoot. Borrowed code carries Chatwoot's bugs until rewritten.
6. **Upstream files are reference-only.** Chatwoot's `CLAUDE.md` / `AGENTS.md` do not govern us; they'll be renamed (e.g. `*.upstream.md`) so they don't get auto-loaded. Our **root `CLAUDE.md`** is the single source of truth — a thin router to decided docs. (Created 2026-07-09.)
7. **Doc philosophy:** many small focused files by domain + a routing index, never one huge file. The `/cowork` scaffold is built out and restructured (2026-07-13): `decisions/`(+`superseded/`), `security/`, `ui-design/`, `product-*`, `reference/`, `deliverables/`, `_archive/`.
8. **Sequence:** design/brand phase comes *after* architecture.

## Architecture decisions locked (grill-me, 2026-07-08 — full detail in `decisions/`)

1. ~~**Backend:** keep Rails~~ → **SUPERSEDED by 0022:** rewrite backend in **NestJS/TypeScript**; Chatwoot = blueprint (schema + behavior + RSpec-as-spec). Component map: Sidekiq→BullMQ, ActionCable→WebSocket, Devise→Passport/JWT, ActiveStorage→S3.
2. **Frontend:** keep Vue; deep redesign with our own design system (shadcn-vue + animations); no React rewrite. **(Reinforced by 0022 — team maintains Vue.)** (0002)
3. **Tenancy:** single-tenant (one account); keep the account model intact as the seam for future multi-tenancy. (0003)
4. **RBAC:** build our own granular roles/permissions with a super admin; no Enterprise custom-roles code. (0004)
5. **Platform:** web app; desktop wrapper (Tauri/Electron) deferred. (0005)
6. **Scope:** support-first (Zendesk-like), extensible. Channels: email + API (mandatory, feeds our existing external LLM widget) now; messengers soon; SMS/telephony later; Captain AI not adopted. Optional areas open. (0006, `product-scope.md`)
7. **Infra:** PostgreSQL + Redis, self-hosted on our own server via Docker. (0007)
8. **In-CRM AI:** deferred until after the skeleton; our own if built. (0008)
9. ~~**Migration:** full clone + Devise~~ → **SUPERSEDED by 0022:** this repo = a **new NestJS+Vue project** (not a whole-repo clone); `../chatwoot` stays untouched reference; auth rebuilt (Passport/JWT).

### Backend deep-dive (2026-07-08) — mostly VOIDED by the 0022 pivot

10. ~~Rails 8.1 upgrade~~ → **VOID (0022)** — no Rails.
11. ~~RSpec CI gate~~ → **SUPERSEDED (0022):** TS tests (Jest/Vitest) are the gate; RSpec = reference behavior spec.
12. Remove `enterprise/` → **moot (0022):** we ship none of Chatwoot's code; enterprise = reference only in ../chatwoot.
13. ~~Full code rebrand~~ → **VOID (0022):** new codebase, ours from the start.
- Backend still-open sub-item under the new stack: **ORM choice** (TypeORM/Prisma/Drizzle), API surface, dependency policy.

### Security deep-dive (2026-07-08)

14. **Blockers/hardening:** SEC-1…SEC-24 accepted as committed must-fixes; Cat-1 gate = no real data until SEC-1…SEC-9 done. (0014)
15. **Retention:** window is a deferred business decision; keep-forever in dev; go-live blocker for real data. (0015)
16. **Backups:** automated encrypted off-host backups + tested restore; storage details deferred. (0016)
17. **MFA:** optional for all for now; super-admin 2FA bypass (SEC-2) still fixed. (0017)
18. **Devices:** each agent on own device → shared-desk findings (SEC-C8/38) downgraded. (0018)
19. **Audit log:** build our own, for sensitive actions (exports, permission changes, deletions, record access). (0019)
20. **Logging/egress/DSAR:** PII stays in DB (product data) but scrubbed from logs; egress allow-list + disable telemetry/push; centralized logging + DSAR deferred. (0020)

### Product-features deep-dive (2026-07-08)

21. **Support toolset:** keep + improve Chatwoot's agent tools (canned, macros, labels, attributes, notes/@mentions, utilities, inboxes, teams, auto-assign, automations, reports, contacts, statuses, priorities). **Mirror Zendesk** for specifics. Slack + webhooks (native-first) + API. Optional areas open (help center leaning needed, CSAT, campaigns, SLA, agent bots). Detail in `product-features.md`. (0021)

**Zendesk config capture — DONE (2026-07-09):** synthesized into `zendesk-findings.md` — unblocked many "like Zendesk" specifics + seeds data migration.
**Current CRM = Zendesk** (operator has access). **External LLM widget** already exists (feeds via API).
**Captured AI ideas (0008 / AI phase):** reply-suggestion panel from KB; LLM ticket classification into categories+sub-categories. Analytics = its own session.

## Sessions structure (two axes)

- **Technical layers:** backend (done, incl. new NestJS stack), security/infra (done), frontend (done — 0025; design foundation → UI session), deployment (done — 0026).
- **Product layer:** product-features (done — 2026-07-08, see product-features.md), UI/design + brandbook.
- Working style: one grill-me session per domain.

## Where we paused

Backend, security/infra, and product-features sessions are done (big decisions). **Still-open (deferred):** backend dependency policy + API surface; security retention/DSAR/backup-storage/centralized-logging (some are go-live gates); product optional areas (help center/CSAT/campaigns/SLA/agent bots); analytics + AI phase. **Done since:** root `CLAUDE.md` router + `plan.md` roadmap created (2026-07-09); Zendesk config captured → `zendesk-findings.md`; `/cowork` docs restructured (2026-07-13). **Not yet started:** UI/design session (design bake-off → CEO pick → brandbook; chart-lib choice). (AI phase = post-skeleton: reply-suggestions from KB, LLM ticket taxonomy.)

## Process

`grill-me` (interrogate every architecture + security decision) → write results into a **decisions log** → root `CLAUDE.md` routes Claude Code to the decided docs. The `security/` docs are analysis **input** to this process, not code instructions.

## Deferred by choice — decide later

- Optional feature areas: help center / knowledge base, CSAT surveys, campaigns (keep vs remove).
- Chatwoot's native web widget: keep or drop, given we already have an external LLM widget feeding via API.
- In-CRM (agent) AI specifics — after the skeleton exists (operator has ideas).
- Detailed RBAC permission matrix (which roles, which app areas) — a product-design task.
- Retention windows (SEC-25) and shared-desk deployment model (SEC-C8) — affect several security ratings.

## Folder map of /cowork (current — 2026-07-13)

- `00-project-context.md` — this file (the resume point).
- `plan.md` — full roadmap, Phases 0–13, small sequential points; Claude Code works one point at a time.
- `performance.md` — optimization instructions (indexes/keyset pagination, no N+1, Redis cache, BullMQ async, list virtualization, budgets; when to extract a service).
- `product-scope.md` — support-first scope, channel plan (**API channel = primary**), keep/remove/replace.
- `product-features.md` — per-feature keep/rework/drop + captured AI ideas.
- `zendesk-findings.md` — ✅ synthesized specs from the Zendesk dump: **~58 agents, 372K closed tickets**, channels = web widget + mobile SDK + email (bot + escalation), L1/L2/L3 taxonomy, 98 macros, round-robin routing, first-reply SLA, **migrate via Zendesk API**. Updates 0006/0026/0027. White-label (0028).
- `spec-kit-guide.md` — how to use github/spec-kit (Spec-Driven Development) with Claude Code, per feature.
- `decisions/README.md` + `decisions/0002..0028-*.md` — active ADRs. `decisions/superseded/` holds **0001/0009/0010/0011/0013** (annulled by the 0022 no-Ruby pivot).
- `security/README.md` — scenario, must-not-regress invariants, how Claude Code uses the security docs.
- `security/findings.md` — 47 findings re-judged into 6 categories, our ratings + status (rework/rewrite checklist).
- `security/external-data-flows.md` — outbound data destinations, keep/disable/decide.
- `ui-design/` — `component-strategy.md` (shadcn-vue = root; fill gaps with headless libs skinned to our tokens), `shadcn-analysis.md` (shadcn/ui is free/MIT copy-paste code you own), `claude-design-workflow.md` (consume Claude Design's visual+tokens, not its React code), `design-lab-brief.md` (the design bake-off brief), `mockups/`.
- `claude-code/instructions.md` — operating manual for Claude Code (work protocol, definition of done, non-negotiables).
- `reference/` — **external inputs (evaluate, NOT truth):** `pm-roadmap-notes.md` (PM's «Zendesk 2.0» roadmap — direct conflicts with our decisions + «вероятно» additions: GR8/player_id, multi-brand at player level, anti-pitching, role-dependent UX), `chatwoot-security-report.md` (external Chatwoot audit).
- `deliverables/` — human-facing generated docs: `Support CRM — Архитектура и функционал (MVP).docx/.pdf`, `spec-kit-guide.pdf`.
- `_archive/` — spent/heavy, **safe to delete:** `getting-started.md` (old prep runbook → superseded by `plan.md` + root `CLAUDE.md`), `zendesk-capture-guide.md` (capture done), old docx drafts, `zendesk-capture-raw/` (35 screens + PDF + `ticket-fields.csv`).

### New backend stack (post-pivot, decided 2026-07-08)
- **NestJS** (TS), **self-hosted Supabase** (Postgres+Auth+Storage), **Prisma** for data + **supabase-js** for auth/storage (Prisma owns migrations), **REST + SSE/WebSocket** (no GraphQL), **BullMQ** jobs, **modular monolith** (extract services later; new independent features may be services). Our **RBAC layers on Supabase Auth**. 5 Supabase security guardrails (0023).

### Deployment (0026, decided 2026-07-08)
- **dev + prod** (staging later). **Single server, Docker Compose + Caddy** (auto-HTTPS → SEC-7). **GitHub Actions** auto-deploy with **test gate** (say "deploy" = merge to main; no manual SSH). Secrets: repo on GitHub, `.env` gitignored, secrets in Actions + server env, all defaults changed (SEC-6). Monitoring: logs (PII-scrubbed) + **Slack DM alerts, no spam**. Zendesk data migration = separate task.

### Frontend stack (0025, decided 2026-07-08)
- Keep **Vue 3.5 / Vite 6 / Tailwind 3.4 / vue-router 4**. State → **Pinia** (gradual, new code Pinia, Vuex migrated on-touch). **Clean new REST API + rewrite the ~123 api-client modules** (UI 984 components stay). **New frontend code in TypeScript** (old JS on-touch). Tests: **Vitest**. Component/design-system foundation (shadcn-vue etc.) **deferred to the UI/design session**.

## Claude Code setup — DONE (2026-07-09)

- **Root `CLAUDE.md`** created at workspace top level (thin router: rules + routing table + directory map).
- **`cowork/plan.md`** — full roadmap, Phases 0–13, small sequential points with *Done when* criteria. Claude Code works one point at a time.
- **`cowork/claude-code/instructions.md`** — operating manual (work protocol, definition of done, non-negotiables).
- **`cowork/ui-design/design-lab-brief.md`** — brief for Claude Code to build the 6-direction design bake-off in **`../design-lab`** (real Vue+shadcn-vue, not a token-swap).
- **`../design-lab/refero-styles/`** — scaffolded folders (family/dub/linear/ventriloc/zkpass) + orchestration `README.md` with correct directive links. **Operator drops the downloaded Refero `DESIGN.md`/tokens into each folder** (auto text-extraction was blocked in this env). Brief + README tell Claude Code to read these, not invent.
- Upstream Chatwoot files **renamed** → `../chatwoot/CLAUDE.upstream.md` / `AGENTS.upstream.md` (won't govern us). `../chatwoot` = read-only reference.
- `../design-lab/` folder created.

**Immediate next action:** run Claude Code on `design-lab-brief.md` to produce the 6 design directions → CEO picks → Cowork codifies the winner into the brandbook (plan Phase 7). Backend Phases 0–6 can start in parallel.

## Notes
- The earlier `cowork/ui-design/mockups/open-ticket.html` was a quick token-swap preview only (primitive) — real mockups come from Claude Code via the design-lab brief.
