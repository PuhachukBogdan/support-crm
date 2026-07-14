# 0010 — Upgrade to Rails 8.1 early (before redesign)

> ⛔ **VOID under 0022 (2026-07-08).** No Rails in the project anymore (backend rewritten in NestJS). Irrelevant. Kept for history.

**Status:** accepted · **Date:** 2026-07-08 · **Security:** closes SEC-8

## Decision

Upgrade the backend from **Rails 7.1.5.2 → Rails 8.1** as one of the first development steps — right after cloning to `/code/crm` and removing `enterprise/` + unused features, and **before** the big redesign and new features. Keep Ruby 3.4.4 (current).

## Verified facts (endoflife.date, data as of 2026-05-01)

- **Rails 7.1 security support ENDED 2025-10-01** — no more security patches (report's SEC-8 confirmed; not just a scare).
- Rails 8.0 security ends 2026-11-06 (soon); 7.2 ends 2026-08-09 (pointless).
- **Rails 8.1** (released 2025-10-22, latest 8.1.3) — security support until **2027-10-10** → longest runway, hence the target.

## Why early

1. It's a Category-1 security blocker (no data before it's done).
2. A framework upgrade is far cheaper on still-clean code, before we pile on custom changes — fewer of our own edits to conflict with Rails changes.
3. The **764-file RSpec suite** is the safety net: it catches upgrade regressions (behavior should be unchanged by the upgrade).

## Approach

- Step through minors: 7.1 → 7.2 → 8.0 → 8.1, keeping the test suite green at each step.
- Chatwoot's own later releases (post-4.15.1) can be consulted as a reference for their upgrade diffs, even though we don't track upstream.

## Consequences

- Framework currency becomes a standing policy (no upstream to lean on) — see the future dependency-audit/gem-update policy.
