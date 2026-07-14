# 0017 — MFA optional for all (for now); super-admin 2FA bypass still fixed

**Status:** accepted · **Date:** 2026-07-08 · **Relates to:** SEC-2

## Decision

Two-factor auth (MFA) is **available but optional for all users** for now. Enforcement (requiring it for admins or everyone) is a policy to revisit later. Independent of this, the **super-admin 2FA bypass bug (SEC-2) is still fixed** — when a user has 2FA enabled, it must be honored everywhere, including super-admin login.

## Consequences

- Keep Chatwoot's existing MFA capability intact; do not remove it.
- Revisit enforcement before/at production, especially for admin/super-admin roles.
