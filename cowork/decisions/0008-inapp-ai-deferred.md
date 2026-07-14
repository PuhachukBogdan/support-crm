# 0008 — In-CRM AI deferred until after the skeleton

**Status:** accepted · **Date:** 2026-07-08

## Decision

No built-in (agent-facing) AI in v1. Revisit **after** the application skeleton exists. If/when built, it is **our own** AI (our provider/model) with its own data-flow decision at that time. Chatwoot's Captain is not adopted.

## Why

- The company's **external LLM widget** already covers front-line customer answers (ingested via the API channel), so in-CRM AI is not urgent.
- AI features are additive and depend on the reworked data model and real agent needs; deciding now would be speculative and could over-constrain the architecture.

## Guardrail (do now)

Keep the seam open so AI can attach cleanly later: preserve the **API channel** and **custom attributes**, and don't hard-wire assumptions that block a future AI module. No third-party conversation data leaves without an explicit decision (external-data-flows.md).

## Consequences

- Operator has ideas to discuss post-skeleton — revisit then.
- Any future AI is a separate decision record covering model choice and data flow.
