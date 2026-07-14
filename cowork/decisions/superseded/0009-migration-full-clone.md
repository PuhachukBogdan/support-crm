# 0009 — Full clone into /code/crm; /code/chatwoot stays as untouched reference

> ⛔ **SUPERSEDED by 0022 (2026-07-08).** `/code/crm` is now a **new NestJS+Vue project**, not a whole-repo clone; auth rebuilt (Passport/JWT), not Devise. `/code/chatwoot` still stays as untouched reference. Kept for history.

**Status:** accepted · **Date:** 2026-07-08

## Decision

Keep `/code/chatwoot` as a **pristine, untouched reference**. Create the product as a **full clone of the Chatwoot repo in `/code/crm`** and do all work there. Exact mechanics are left to Claude Code, but the model is **"fork the whole repo, then carve it down and rework in place"** — not cherry-picking modules.

## Why

- We keep both the Rails backend (0001) and Vue frontend (0002), so most of the codebase is retained and reworked — a whole-repo clone is the natural starting point.
- Chatwoot is a monolith; extracting isolated modules drags in coupled dependencies and is painful. Carving down a full copy is cleaner.
- A pristine reference copy lets us diff against upstream behavior while we rework.

## Expectation alignment

"Throwing Chatwoot away" is a **gradual process** (rewrite parts within our fork until little original remains), not a deletion event. The time savings come from starting on a working app, at the cost of inheriting Chatwoot's architecture as the starting point.

## First carve-down steps for Claude Code (later)

- Remove `enterprise/` (licensed; not used — see 0004).
- Remove channels/features marked for removal (product-scope.md), which also closes their security findings.
- Rename upstream `CLAUDE.md` / `AGENTS.md` in the clone (e.g. `*.upstream.md`) so they don't govern us; our root `CLAUDE.md` becomes the single source of truth.

## Auth note (follows from keeping Rails)

Keep Chatwoot's Devise/JWT/MFA auth and **harden** it per security findings (SEC-2, SEC-4, SEC-5, SEC-11, SEC-14). Not a new auth system.
