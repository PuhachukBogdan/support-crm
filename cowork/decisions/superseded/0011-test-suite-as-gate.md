# 0011 — Keep the RSpec suite as a CI gate; tests co-evolve with code

> ⛔ **SUPERSEDED by 0022 (2026-07-08).** New stack is TS → the running test gate is Jest/Vitest. Chatwoot's RSpec suite is kept only as a **reference behavior spec** (what the backend must do), not runnable against our code. Principle "tests as a gate" still holds. Kept for history.

**Status:** accepted · **Date:** 2026-07-08

## Decision

Keep and maintain Chatwoot's **RSpec test suite** (764 spec files) as the backend regression safety net. A **green suite is required in CI before merging** any rework. Tests **co-evolve with the code**: when we change behavior, we update the specs; when we remove a feature, we remove its specs; new code ships with new tests.

## Why

- Directly mitigates the core vibecoding risk (generation is cheap, verification is the bottleneck) — the suite is the objective check on code the operator cannot eyeball.
- Essential for the Rails 8.1 upgrade (0010): behavior must stay unchanged, so specs must stay green through the upgrade.
- Guards regressions in the retained backend logic during redesign.

## Notes

- The suite is not a frozen oracle — it tracks Chatwoot's current behavior and will shift as we remove/rework features. That's expected; the invariant is "code and its tests move together, CI stays green."
- Frontend gets its own tests (Vue/Vitest) under the same principle.
