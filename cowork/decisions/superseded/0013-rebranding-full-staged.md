# 0013 — Full rebrand, staged: user-facing now, internal rename as an isolated later pass

> ⛔ **VOID under 0022 (2026-07-08).** The new codebase is written from scratch under our own name — there's no Chatwoot code to rename. The ~1333-file rename problem disappears. Kept for history.

**Status:** accepted · **Date:** 2026-07-08

## Decision

Rebrand fully (including internal identifiers), but **staged**:

1. **User-facing rebrand — early:** app name, logo, favicon, UI copy (i18n, ~160 locale files), emails, page titles, installation-config display defaults.
2. **Full internal rename — a dedicated, isolated pass AFTER the app is stable** (after the Rails 8.1 upgrade and base rework), with the RSpec suite green before and after. Covers `module Chatwoot`, `Chatwoot::*` constants, and the ~1333 files referencing "chatwoot".

## Why staged (not all at once)

- "chatwoot" lives in **runtime-sensitive places**, not just text: ENV var names (`CHATWOOT_*`, `INSTALLATION_NAME`), the **Redis namespace** (job queues + cache keys), **installation-config values in the DB**, storage paths. A blind find-replace silently breaks jobs/config — these must be changed deliberately, with migration of existing keys where needed.
- Mixing a 1333-file mass rename with the Rails 8.1 upgrade and the redesign makes failures impossible to isolate. Three big changes must not overlap.

## Consequences

- Claude Code executes the internal rename as its own milestone with a clear before/after green-test gate.
- Watch items during the internal pass: ENV var renames (+ compatibility), Redis namespace migration, installation-config keys, ActiveStorage paths.
