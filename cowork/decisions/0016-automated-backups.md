# 0016 — Automated encrypted database backups (storage details deferred)

**Status:** accepted (approach) · storage TBD · **Date:** 2026-07-08 · **Relates to:** SEC-20

## Decision

Build **automated, encrypted database backups to off-server storage**, with a **tested restore** procedure. Chatwoot ships no backup tooling today, so this is net-new. The **where/how of storage** (provider, location, frequency/RPO, retention of backups) is **deferred** — the operator flagged it as important and wants to decide separately.

## Consequences

- Set up before production with real data (part of infra hardening).
- Backup retention interacts with the data-retention decision (0015) — decide together.
- Backups must be encrypted and access-controlled (they contain the same PII as the DB).
