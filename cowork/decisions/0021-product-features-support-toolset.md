# 0021 — Product-features: keep the support toolset, mirror Zendesk, defer AI ideas

**Status:** accepted (direction) · **Date:** 2026-07-08 · **Detail:** `../product-features.md`

## Decision

Keep Chatwoot's support toolset as the baseline and improve it, rather than rebuild. Walkthrough result:

- **Keep:** canned responses, macros (engine), labels, custom attributes, private notes + @mentions, conversation utilities (participants/search/files/contact panel), inboxes, teams, auto-assignment, automations (engine), reports (baseline), contacts/companies, ticket statuses, priorities.
- **Mirror Zendesk** for specifics: labels, attributes, routing/auto-assignment, ticket identifier format, terminology ("ticket"). Many "decide later" answers were "same as Zendesk."
- **Slack** integration enabled; **webhooks** kept as a cheap generic outlet (prefer native integrations); API channel mandatory.
- **Open (optional) areas:** help center (leaning needed — AI KB source), CSAT, campaigns, SLA, agent bots.

## Near-term priority task (unblocks many specifics)

**Capture the company's Zendesk configuration.** Cowork writes step-by-step instructions; operator provides screenshots/exports of attributes, labels, macros, custom fields, views, routing, SLAs, ticket ID format. This turns dozens of "like Zendesk" answers into concrete specs, and feeds the data-migration plan.

## Captured AI ideas (AI phase, 0008)

1. **AI reply-suggestion panel** from the company knowledge base (cost caveat; needs a KB → pulls help center toward "needed").
2. **LLM ticket classification** into categories AND sub-categories for richer analytics.

Analytics deserves its own dedicated session.
