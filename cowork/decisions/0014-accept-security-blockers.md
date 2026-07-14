# 0014 — Accept security blockers + core hardening as committed must-fixes

**Status:** accepted · **Date:** 2026-07-08 · **Source:** `../security/findings.md`

## Decision

All **Category-1 blockers (SEC-1…SEC-9)** and the **Category-2 hardening items (SEC-10…SEC-18)** and deployment-hygiene items (SEC-19…SEC-24, SEC-39) are **accepted as committed fixes**, not open questions. They are implemented by Claude Code during the rework. The Category-1 gate stands: **no real company/customer data enters the system until every SEC-1…SEC-9 item is `done`** (or a documented `n/a`).

## Notes / already resolved by earlier decisions

- SEC-33 (Enterprise license) — dissolved: we ship no Enterprise/paid code (0012).
- SEC-C1 (conversations to third-party LLM) — dissolved: no Captain, external LLM is the company's own (0006, 0008).
- SEC-2 (super-admin 2FA) — mandatory, tied to our own RBAC/super-admin (0004).
- SEC-8 (Rails EOL) — closed by the Rails 8.1 upgrade (0010).
- SEC-11 (token in JS cookie) — accept the httpOnly fix as an early architectural change.

## What remains as real decisions (this session)

Policy/product choices that change the outcome and need the operator: compliance regime, data-retention windows, shared-desk deployment, MFA enforcement, centralized logging, backup approach. These get their own decision records.
