# Decisions Log (ADRs)

One file per decision, kept small. This is the **output** of our grill-me sessions and the source of truth the future root `CLAUDE.md` will route to. Status of each: `accepted` · `superseded` · `open`.

> **Superseded/void ADRs (0001, 0009, 0010, 0011, 0013) now live in `superseded/`** — kept for history, out of the active set. They were annulled by the 0022 no-Ruby pivot.

| # | Decision | Status | Date |
|---|----------|--------|------|
| 0001 | ~~Keep Chatwoot's Rails backend~~ → **superseded by 0022** (no Ruby; NestJS backend) | superseded | 2026-07-08 |
| 0002 | Keep Vue frontend; deep redesign with our own design system (shadcn-vue), no React rewrite | accepted | 2026-07-08 |
| 0003 | Single-tenant now; keep account model as the seam for easy future multi-tenancy | accepted | 2026-07-08 |
| 0004 | Build our own granular RBAC (super-admin-managed); no Enterprise custom-roles code | accepted | 2026-07-08 |
| 0005 | Web application; desktop wrapper (Tauri/Electron) deferred | accepted | 2026-07-08 |
| 0006 | Support-first scope (Zendesk-like), extensible; channels fixed; Captain AI not adopted | accepted | 2026-07-08 |
| 0007 | PostgreSQL + Redis, self-hosted on our own server via Docker | accepted | 2026-07-08 |
| 0008 | In-CRM (agent) AI deferred until after skeleton; own AI if any | accepted | 2026-07-08 |
| 0009 | ~~Full clone + Devise~~ → **superseded by 0022** (the new project = NestJS+Vue; auth rebuilt) | superseded | 2026-07-08 |
| 0010 | ~~Rails 8.1 upgrade~~ → **void (0022)** — no Rails | void | 2026-07-08 |
| 0011 | ~~RSpec CI gate~~ → **superseded by 0022** (TS tests are the gate; RSpec = reference spec) | superseded | 2026-07-08 |
| 0012 | Remove enterprise/ → moot under 0022 (ship none of Chatwoot's code; enterprise = reference only) | moot | 2026-07-08 |
| 0013 | ~~Full rebrand of code~~ → **void (0022)** — new codebase is ours from the start | void | 2026-07-08 |
| 0014 | Accept security blockers + core hardening as committed must-fixes (Cat-1 gate) | accepted | 2026-07-08 |
| 0015 | Data retention: deferred business decision; keep-forever in dev; go-live blocker | open (deferred) | 2026-07-08 |
| 0016 | Automated encrypted DB backups (storage details deferred) | accepted | 2026-07-08 |
| 0017 | MFA optional for all for now; super-admin 2FA bypass still fixed | accepted | 2026-07-08 |
| 0018 | Agents use personal devices; shared-desk findings downgraded | accepted | 2026-07-08 |
| 0019 | Build our own audit log for sensitive actions | accepted | 2026-07-08 |
| 0020 | Log hygiene (PII out of logs), egress allow-list; DSAR deferred | accepted (DSAR deferred) | 2026-07-08 |
| 0021 | Product-features: keep support toolset, mirror Zendesk, defer AI ideas; Zendesk-capture task | accepted (direction) | 2026-07-08 |
| 0022 | **PIVOT: no Ruby → rewrite backend in NestJS/TS; Chatwoot = blueprint; keep Vue** (supersedes 0001/0009/0010/0011/0013) | accepted | 2026-07-08 |
| 0023 | DB platform: **self-hosted Supabase** (Postgres+Auth+Storage); NestJS is the brain; +5 security guardrails | accepted | 2026-07-08 |
| 0024 | Backend details: Prisma+supabase-js; REST + SSE/WS (no GraphQL); modular monolith, extract later | accepted | 2026-07-08 |
| 0025 | Frontend details: keep Vue3/Vite/Tailwind; Pinia (gradual); clean API + rewrite api layer; new code TS; Vitest | accepted | 2026-07-08 |
| 0026 | Deployment: dev+prod; Docker Compose + Caddy(auto-HTTPS); GitHub Actions auto-deploy w/ test gate; .env/gitignore secrets; logs + Slack alerts; Zendesk migration = task | accepted | 2026-07-08 |
| 0027 | Analytics: both layers; in-app branded dashboards now + Metabase OSS (isolated) internal-only later; LLM taxonomy → AI phase (reserve category/sub-category fields) | accepted | 2026-07-08 |
| 0028 | White-label / multi-brand; light+dark themable (CSS vars); neutral base palette; company colors = infographic-only | accepted | 2026-07-09 |

## Still open (deferred by choice — decide later)

- **Backend — dependency/gem update policy** (CI audit gate, pin floating gems): user deferred, explain simply later.
- **Backend — API surface**: what to keep/expose from `/api` (v1, platform API, superadmin) — not yet discussed.
- **Security — data retention window (0015) + DSAR (0020)**: business decisions with stakeholders; go-live blockers for real customer data.
- **Security — backup storage location/frequency (0016)**: decide separately.
- **Security — centralized logging**: deferred; gated on log PII-scrubbing.
- **Product — optional areas**: help center (leaning needed), CSAT, campaigns, SLA, agent bots.
- **Product — Zendesk config capture** (near-term): Cowork to write capture instructions; operator provides screenshots/exports.
- **Analytics**: own dedicated session (incl. LLM sub-category classification idea).
- **AI phase (0008)**: reply-suggestion panel from KB; LLM ticket classification.
- **Migration**: Zendesk data → new system (contacts/history/tickets) — deployment/migration session.

- Optional areas: help center / CSAT / campaigns (keep vs remove)
- Web widget (Chatwoot native): keep or drop given external LLM widget
- In-CRM AI specifics (post-skeleton)
- Detailed RBAC permission matrix (product-design task)
