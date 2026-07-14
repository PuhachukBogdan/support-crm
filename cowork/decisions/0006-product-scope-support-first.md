# 0006 — Support-first scope (Zendesk-like), extensible; channel set fixed

**Status:** accepted (direction) · **Date:** 2026-07-08 · **Detail:** see `../product-scope.md`

## Decision

The CRM is **customer-support-first** (Zendesk as reference), architected to **extend** later (possibly sales/pipeline). Channel plan: **Email + API channel now (API mandatory)**, **messengers now/soon**, **SMS/telephony in future**, niche channels (TikTok/X/LINE) likely removed. Optional areas (help center, CSAT, campaigns) remain **open**. Chatwoot's Captain AI is **not adopted**.

## Key facts driving it

- The company already runs its **own external LLM widget** on its website; the CRM must ingest those conversations via the **API channel** — hence API channel is mandatory and Chatwoot's own AI is unnecessary.
- Chatwoot has no sales pipeline/deals; any such feature is future new-build, so we keep the model extensible.

## Boundary note

This and `product-scope.md` are **plans for Claude Code**, not executed changes. Cowork never modifies `../chatwoot`; Claude Code will implement keep/remove/replace in this repo.

## Consequences

- Removing unused channels also closes their security findings (SEC-C2/C3).
- Optional-area decisions still pending; do not remove those without a later explicit decision.
