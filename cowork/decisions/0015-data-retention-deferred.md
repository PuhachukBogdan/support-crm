# 0015 — Data retention: deferred business decision; keep-forever during dev; go-live blocker

**Status:** open (deferred) · **Date:** 2026-07-08 · **Relates to:** SEC-25

## Decision

The **data-retention window** (how long conversations/attachments/contacts are kept before auto-deletion) is a **business decision the operator cannot make alone** — it needs the relevant stakeholders. It is **deferred**.

- **During development:** data is kept indefinitely ("forever"). Acceptable because it's test data only.
- **Before production with real customer data:** a retention window MUST be chosen, and the auto-delete capability built (SEC-25). This is a **go-live blocker**, not a dev blocker.

## Consequences

- Claude Code does not build retention now, but should keep the data model friendly to adding a retention/cleanup job later (timestamps present; no obstacles to bulk deletion).
- Flag for the operator: schedule the retention decision with stakeholders before real customer data is loaded.
