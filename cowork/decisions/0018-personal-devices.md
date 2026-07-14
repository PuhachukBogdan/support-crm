# 0018 — Agents use personal devices; shared-desk findings downgraded

**Status:** accepted · **Date:** 2026-07-08 · **Relates to:** SEC-C8, SEC-38

## Decision

Each agent works on their **own personal computer** (no shared/shift machines). Therefore the browser-persistence findings — drafts/private notes (SEC-C8) and search history (SEC-38) leaking to the next user on a shared machine — are **downgraded to low priority / effectively n/a**.

## Consequences

- Still apply the cheap hygiene (clear drafts/search on logout / session expiry) as defense-in-depth, but it's not a gate.
- If a shared-desk model is ever introduced later, re-raise SEC-C8/SEC-38 to P1.
