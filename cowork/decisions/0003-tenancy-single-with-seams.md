# 0003 — Operate single-tenant, keep the account model as the seam for future multi-tenancy

**Status:** accepted · **Date:** 2026-07-08

## Decision

Run the CRM as **single-tenant** (one company = one `account`). **Keep Chatwoot's account model and `account_id` scoping fully intact** — do not remove multi-tenancy. This leaves multi-tenancy re-enablable later with minimal work.

## Context

- `account_id` appears ~151 times in the schema; 35 models `belongs_to :account`; all authorization policies are account-scoped. The security review flagged tenant isolation as a **strength / must-not-regress**.
- Only our company uses the product now; operator wants an easy path to multi-tenant "just in case".

## Why

- Removing multi-tenancy is surgery on a load-bearing wall (35 models, all policies) for a purely cosmetic simplification, and would risk the isolation guarantees we want to keep.
- Keeping the account model and running a single account **is** the "seam": multi-tenant is already there, just unused. No extra work needed to preserve the future option.
- Internal org structure is handled *inside* the account via inboxes and teams, not via multiple accounts.

## Consequences

- One seeded account; users all live under it.
- Tenant-isolation invariants (security README) remain in force — do not weaken `account_id` scoping during rework.
- "account" may be hidden from the UI later (a UI concern, not a data-model change).
