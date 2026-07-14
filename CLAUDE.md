# CLAUDE.md — Root instructions for Claude Code

> **This file is the single source of truth for how to work in this repository.** It is a thin router: it states the hard rules and points to the detailed docs in `cowork/`. Read the specific doc a task needs — do not load everything.

## What we're building

A **white-label / multi-brand internal support CRM** (Zendesk-style), for a support operation with ~58 agents and a large ticket history. We use the open-source **Chatwoot** codebase as a **reference/blueprint** — not as a fork.

- **Backend:** rewritten in **NestJS (TypeScript)**. Data via **Prisma**; auth/storage via **Supabase**. REST + SSE/WebSocket. BullMQ jobs. Modular monolith.
- **Frontend:** **Vue 3 + Vite + Tailwind + shadcn-vue** (kept from Chatwoot, redesigned).
- **DB/infra:** **self-hosted Supabase** (Postgres+Auth+Storage) + Redis, Docker Compose, Caddy. Data stays in-house.
- **Branding:** white-label — no company identity hardcoded; theme via CSS variables (light+dark).

Full rationale: `cowork/decisions/` (ADRs 0001–0028). Start-of-context: `cowork/00-project-context.md`.

## Directory map

> **This repo root (`…\\crm-foundation\\code\\crm`) is where Claude Code runs and where `git init` lives.** Paths below are relative to it.

- `.` **(this repo, root)** — **the product.** All real implementation happens here (`api/`, `web/`, …).
- `cowork/` — **the knowledge base / source of truth** (decisions, plan, product scope, security, UI/design). Subfolders: `decisions/` (+ `superseded/`), `security/`, `ui-design/`, `reference/` (external inputs — **not** authoritative), `deliverables/`, `_archive/` (safe to delete).
- `../chatwoot/` — **READ-ONLY Chatwoot reference, OUTSIDE this repo.** Never modify. Its `CLAUDE.upstream.md` / `AGENTS.upstream.md` are upstream — ignore for our decisions.
- `../design-lab/` — **throwaway design bake-off, OUTSIDE this repo** (see `cowork/ui-design/design-lab-brief.md`). Not the product.

## Hard rules

1. **Work by `cowork/plan.md`, one point at a time.** Implement a point → report completion → wait. Keep changes scoped to the current point.
2. **Never modify `../chatwoot/`.** It is reference only.
3. **Source of truth is `cowork/`.** For any task, read the relevant doc(s) (routing below) — not all of them.
4. **Definition of done per point:** code + a test that fails without the change and passes with it + green test suite + note what changed. Update the point's status in `plan.md`.
5. **Security gate:** no real company/customer data enters the system until all Category-1 (P0) items in `cowork/security/findings.md` are done. Build security invariants in from the start (see below).
6. **White-label:** never hardcode a brand (name/logo/colors). Branding is per-brand config via CSS-variable tokens (decision 0028).
7. **Must-build-correctly invariants:** tenant/account isolation, RBAC in the policy layer, SSRF protection on outbound requests, sound auth, no PII in logs. See `cowork/security/README.md`.

## Routing — which doc for which task

| Task touches… | Read |
|---------------|------|
| Any architectural "why" | `cowork/decisions/README.md` → the specific ADR |
| What to build / scope / features | `cowork/product-scope.md`, `cowork/product-features.md` |
| Zendesk config to replicate / data migration | `cowork/zendesk-findings.md` |
| Security (fixes, gate, invariants) | `cowork/security/README.md` + `findings.md` |
| Performance (queries, lists, caching, async, budgets) | `cowork/performance.md` |
| Outbound data / integrations / telemetry | `cowork/security/external-data-flows.md` |
| UI / components / theming / brandbook | `cowork/ui-design/` |
| How to work as Claude Code | `cowork/claude-code/instructions.md` |
| How to bootstrap / first run (specify + Claude Code + order) | `cowork/claude-code/start-implementation.md` |
| The task list itself | `cowork/plan.md` |
| PM roadmap & external inputs (evaluate, **not** truth) | `cowork/reference/` |

When in doubt, start at `cowork/00-project-context.md`.


## Wiki Knowledge Base (development memory)

A companion Obsidian vault holds the **development history / memory** for this project (session notes, practical "why we did X", gotchas, external-system behavior). It **complements** — does not replace — this repo's `cowork/`, which stays the source of truth for decisions, roadmap, and security.

- **Path:** `C:\Dev\claude-obsidian\vaults\crm`

When you need context **not** already in this repo (past sessions, why something was done in practice, a known gotcha):
1. Read `vaults/crm/wiki/hot.md` first (~500-word recent context).
2. If not enough, read `vaults/crm/wiki/index.md`.
3. For domain specifics, read `vaults/crm/wiki/<domain>/_index.md` (decisions · modules · integrations · gotchas).
4. Only then open individual pages.

Do **not** read the wiki for general coding questions or things already in `cowork/`. After a substantial session, file a `sessions/` note there (`/save`) and append a line to `wiki/log.md`. Decisions of record still live in `cowork/decisions/` (ADRs); the wiki links to them by number, never copies them.
