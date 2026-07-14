# 0020 — Logging hygiene, egress control, DSAR (security session close-out)

**Status:** accepted (except DSAR deferred) · **Date:** 2026-07-08 · **Relates:** SEC-26, SEC-11, SEC-12, SEC-31, external-data-flows.md

## Decisions

1. **PII in DB vs logs — clarified.** Customer PII (email, phone, message text) **is stored in the database per customer** — that is the CRM's core function, untouched. Log **hygiene** applies only to **log files** (diagnostic/error output): scrub PII and stop logging full third-party response bodies. Logs ≠ database. (SEC-26)
2. **Centralized log aggregation — deferred.** If ever enabled, only *after* log PII-scrubbing is in place (gated).
3. **Egress control — accepted.** Enforce an outbound allow-list; disable vendor telemetry and the third-party push relay by default; keep data in-house. (external-data-flows.md)
4. **DSAR (customer request to export/delete their data) — deferred.** A business decision tied to data-retention (0015); revisit with stakeholders before production. (SEC-31)
5. **Session token httpOnly + baseline CSP — accepted** (already in blockers/hardening, 0014). (SEC-11, SEC-12)

## Consequences

- Claude Code implements log scrubbing + egress allow-list as hardening.
- DSAR + retention decided together, later, with business owners — both are go-live gates for real customer data.
