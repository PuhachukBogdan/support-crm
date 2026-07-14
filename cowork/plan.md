# plan.md — Development Roadmap (work one point at a time)

> **How to use:** work top-to-bottom. Do **one point**, satisfy its *Done when*, mark `[x]`, report completion, then move to the next. Keep each change scoped to its point. Every point: code + test (fails without, passes with) + green suite. Rules & routing: root `CLAUDE.md`. Rationale: `cowork/decisions/`.
>
> **Parallelism:** Phases 0–6 (backend/infra) do **not** depend on the visual design. The **design bake-off** (`ui-design/design-lab-brief.md`) runs in parallel; **Phases 7–8 (frontend) start only after the CEO picks a design and the brandbook exists.**
>
> **Hard gate:** no real company/customer data until every Category-1 item in `security/findings.md` is done (see Phase 11).
>
> Status legend: `[ ]` todo · `[~]` in progress · `[x]` done. Keep statuses current.

---

## Phase 0 — Project setup (repo root)
- [ ] 0.1 Scaffold NestJS backend app in `api` (TypeScript, strict). *Done when:* `npm run start` boots a health endpoint.
- [ ] 0.2 Scaffold Vue 3 + Vite + Tailwind frontend in `web`. *Done when:* dev server serves a blank shell.
- [ ] 0.3 Add shadcn-vue + Reka UI + base tokens file (`tokens.css` placeholder). *Done when:* one shadcn-vue Button renders themed.
- [ ] 0.4 Tooling: ESLint + Prettier + TypeScript configs (front+back); `npm run lint` clean.
- [ ] 0.5 Test runners: Jest (api) + Vitest (web), each with one passing sample test.
- [ ] 0.6 Monorepo layout + root scripts (run api+web+lint+test). *Done when:* one command runs everything.
- [ ] 0.7 CI skeleton (GitHub Actions): install → lint → test on push. *Done when:* pipeline green on a trivial PR.

## Phase 1 — Infra baseline (Docker, local dev)
- [ ] 1.1 Docker Compose: self-hosted **Supabase** stack + **Redis**. *Done when:* `docker compose up` brings them up locally.
- [ ] 1.2 **Change ALL default secrets** (Supabase JWT/DB/Studio); app **refuses to start** if a required secret is unset (SEC-6). Firewall Studio/Kong (not public).
- [ ] 1.3 `.env.example` + `.env` in `.gitignore`; document required vars.
- [ ] 1.4 Caddy reverse proxy: `/`→web, `/api`→api, **auto-HTTPS** (SEC-7). *Done when:* local https works.
- [ ] 1.5 Backend connects to Supabase Postgres via Prisma; Redis via BullMQ. *Done when:* health check reports both OK.

## Phase 2 — Data model (Prisma, from Chatwoot schema as blueprint)
- [ ] 2.1 Port core tables from Chatwoot schema to Prisma: accounts, users, account_users. *Done when:* migration applies; models typed.
- [ ] 2.2 Contacts + companies + custom-attribute definitions (+ reserve **category/sub-category + classified-by** fields on tickets — 0027).
- [ ] 2.3 Conversations/tickets, messages, attachments.
- [ ] 2.4 Inboxes, teams, labels, macros, canned responses, automations.
- [ ] 2.5 Account-scoping (`account_id`) on every tenant-owned table + Prisma middleware enforcing it (tenant isolation invariant). *Done when:* a cross-account query test is blocked.
- [ ] 2.6 Seed script: one account, sample data (brand-neutral).

## Phase 3 — Auth + RBAC
- [ ] 3.1 Integrate **Supabase Auth**; NestJS validates Supabase JWTs on every request. *Done when:* protected route rejects no/invalid token.
- [ ] 3.2 **Honor MFA everywhere** incl. any admin/super-admin path (no bypass — SEC-2).
- [ ] 3.3 Our **RBAC** layer: roles + per-area permissions as NestJS guards (0004). Roles at least: agent, admin, super-admin.
- [ ] 3.4 Super-admin can create users and set/change their roles/permissions.
- [ ] 3.5 Password-reset tokens **expire** (SEC-4/5); account lockout after repeated failures (SEC-14).
- [ ] 3.6 Session token in **httpOnly** cookie; baseline CSP (SEC-11/12).

## Phase 4 — Core domain backend (small points each)
- [ ] 4.1 Conversations: list/filter/open, statuses (open/pending/resolved/snoozed), priority.
- [ ] 4.2 Messages: send/receive, private notes (never leak to customer — SEC-13), @mentions.
- [ ] 4.3 Contacts/companies CRUD + custom attributes.
- [ ] 4.4 Assignment: manual + **round-robin auto-assignment** within group/capacity (mirror Zendesk — zendesk-findings).
- [ ] 4.5 Teams/inboxes management.
- [ ] 4.6 Labels + macros + canned responses (engines).
- [ ] 4.7 Automations engine (triggers: conditions → actions).
- [ ] 4.8 SLA: **first-reply-time** policy (zendesk-findings).
- [ ] 4.9 Audit log for sensitive actions (exports, permission changes, deletions, record access — SEC-29/0019).
- [ ] 4.10 Uploads: single validated path, size/type checks, ownership-checked links (SEC-1/10).
- [ ] 4.11 Exports (contacts/reports): expiring links + audit + rate-limit (SEC-21/22).

## Phase 5 — Channels
- [ ] 5.1 **API channel** (mandatory): ingest external LLM-widget conversations as tickets.
- [ ] 5.2 **Web chat widget** (embeddable) + its backend.
- [ ] 5.3 **Mobile in-app chat**: iOS + Android SDK integration path.
- [ ] 5.4 **Email** channel (inbound/outbound).
- [ ] 5.5 Per-channel credential scoping; webhook **signature verification** where applicable (SEC-C2/C3/C6).

## Phase 6 — Realtime + jobs
- [ ] 6.1 WebSocket layer (presence, new-message, typing) — **exclude private activity from customer connections** (SEC-13).
- [ ] 6.2 SSE endpoint for streaming (future AI reply suggestions).
- [ ] 6.3 BullMQ: background jobs (notifications, exports, webhooks, scheduled cleanup hooks).

## Phase 7 — Frontend foundation (AFTER design chosen + brandbook)
- [ ] 7.1 Apply chosen **brand tokens** (`tokens.css`) + light/dark theming (0028).
- [ ] 7.2 Pinia store setup; new state in Pinia (0025).
- [ ] 7.3 Rewrite the **API-client layer** against our REST API (0025).
- [ ] 7.4 shadcn-vue base components in-repo + our overrides; internal component registry (component-strategy.md).
- [ ] 7.5 Auth flow UI (login, reset) on Supabase Auth.

## Phase 8 — Core screens (small points each)
- [ ] 8.1 App shell + navigation + theme switcher.
- [ ] 8.2 **Inbox** (ticket list + filters + views).
- [ ] 8.3 **Conversation view** (thread, composer, macros/canned, private notes, labels).
- [ ] 8.4 **Contact panel** (attributes, history).
- [ ] 8.5 Settings (users/roles, teams, inboxes, macros, automations).
- [ ] 8.6 Saved **views** (mirror Zendesk views).

## Phase 9 — Support features polish
- [ ] 9.1 Keyboard shortcuts / command palette.
- [ ] 9.2 Bulk actions.
- [ ] 9.3 Bot-handled + agent-escalation flow (matches current bot/escalation model).
- [ ] 9.4 CSAT (optional — decide) ; help center (optional — decide, needed if AI-from-KB).

## Phase 10 — Analytics
- [ ] 10.1 In-app **branded dashboards** (ECharts, themed to tokens): volume, first-reply/resolution time, backlog, by channel/label/team.
- [ ] 10.2 Category/sub-category breakdown surface (fed later by AI classification).
- [ ] 10.3 (Later, internal) self-hosted **Metabase**, telemetry off, behind egress allow-list (0027).

## Phase 11 — Security hardening + ops (GATE before real data)
- [ ] 11.1 Close every **Category-1** item in `security/findings.md` (SEC-1..SEC-9). *Gate.*
- [ ] 11.2 Category-2 hardening (SEC-10..SEC-18): CSP, token expiry, lockout, upload validation, policy-layer scoping (SEC-17), SQL allow-list tests (SEC-18).
- [ ] 11.3 **PII scrubbing from logs** (SEC-26); no full third-party response bodies.
- [ ] 11.4 **Egress allow-list**; disable vendor telemetry/push (external-data-flows.md).
- [ ] 11.5 **Automated encrypted DB backups** off-host + tested restore (SEC-20/0016).
- [ ] 11.6 Containers non-root, pinned image tags (SEC-19); storage bucket privacy (SEC-39).
- [ ] 11.7 Dependency-audit CI gate (bundler-audit N/A; **npm audit** fails build on new critical/high).
- [ ] 11.8 Decide **retention** window + DSAR (business decision) and implement retention job (SEC-25 — go-live gate).

## Phase 12 — Zendesk data migration (via API)
- [ ] 12.1 Zendesk API export scripts (paginated): tickets, users, organizations, macros, triggers, automations, views, groups, ticket_fields, SLA.
- [ ] 12.2 Field/label/attribute mapping to our schema (per zendesk-findings.md).
- [ ] 12.3 Import + verify counts (≈372K tickets) on a staging DB before production.

## Phase 13 — AI phase (post-skeleton, own AI — 0008)
- [ ] 13.1 Decide taxonomy (fixed/open/hybrid — seed = Zendesk L1/L2/L3).
- [ ] 13.2 LLM **ticket classification** → category + sub-category (analytics).
- [ ] 13.3 **AI reply-suggestion panel** from a knowledge base (needs KB/help center); cost controls; SSE streaming.
- [ ] 13.4 Data-flow decision record for any third-party model.
