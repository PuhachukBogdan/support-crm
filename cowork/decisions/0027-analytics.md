# 0027 — Analytics

**Status:** accepted (accumulating) · **Date:** 2026-07-08 · **Relates:** 0021 (reports), 0008 (AI phase)

## 1. Two layers, both wanted

- **Operational KPIs** (baseline, from Chatwoot's reports rebuilt in our stack): ticket volume, first-response time, resolution time, backlog, agent workload, breakdowns by channel/label/team.
- **Insight analytics** (differentiator): **LLM-classified categories AND sub-categories** — "what customers actually contact us about," in fine breakdown, with trends over time.

## 2. Tooling — in-app branded dashboards (now); Metabase OSS later (internal only)

- **Product-facing analytics = in-app dashboards** built with a chart library (ECharts / Chart.js for Vue), **styled to our brandbook**. Priority / built now. Rationale: Metabase's full theming/white-label is a **paid** feature; OSS Metabase looks like Metabase and would clash with our design — unacceptable for product-facing analytics.
- **Metabase OSS (self-hosted, isolated, telemetry OFF, behind egress allow-list)** = an **internal admin-only** exploration/BI tool for the operator's own deep digging where branding doesn't matter. **Not built in parallel** — added later when the operator gets to it.
- Isolation: Metabase must have its phone-home/telemetry disabled and sit behind the egress allow-list (0020); read-only DB access; PII access-controlled.

## 3. LLM classification taxonomy — deferred to the AI phase (0008)

- Whether categories are **fixed / open / hybrid** is decided in the AI phase.
- **Do now (schema readiness):** reserve **category + sub-category fields on the ticket**, plus a **"classified by" flag (LLM vs human)**, so the AI-phase taxonomy decision isn't blocked by the data model.
- **Seed found (Zendesk capture 2026-07-09):** Zendesk already has a hierarchical topic taxonomy — `Form L1 - {Account, Deposits, Withdrawal, Promotions/bonus, Verification, VIP, Product, Issues}` → `L2` → `L3`. This is a ready **fixed top level** for a **hybrid taxonomy** (their L1/L2 fixed + LLM refines within). See `../zendesk-findings.md`.

## Chart library note
- Pick a themeable chart lib for Vue (e.g. ECharts or Chart.js) during the UI/design session so it inherits the brandbook tokens.
