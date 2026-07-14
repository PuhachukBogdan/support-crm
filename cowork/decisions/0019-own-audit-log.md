# 0019 — Build our own audit log for sensitive actions

**Status:** accepted · **Date:** 2026-07-08 · **Closes/relates:** SEC-29, SEC-21, SEC-22, SEC-30, SEC-41

## Decision

Build our **own audit log** (Chatwoot's full audit was Enterprise-only, which we remove — 0012). Record **sensitive actions**, not every click:

- data **exports** (contacts, reports, surveys) — closes SEC-21/SEC-22 "no audit trail"
- **permission/role changes** (ties to our RBAC, 0004)
- **deletions** (incl. account deletion — SEC-41)
- **access to customer records** (who viewed a contact's data)

## Why

- Answers "who accessed/exported this customer's information" — internal accountability + a compliance building block.
- Cheap insurance; scoped to sensitive events so it stays manageable.

## Consequences

- The RBAC super-admin actions and the export features must write audit entries.
- Audit entries themselves contain references to PII access — protect and retention-manage them alongside 0015.
