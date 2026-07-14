# 0004 — Build our own granular roles & permissions (RBAC)

> 🔄 **Updated by 0023 (2026-07-08):** identity/login is handled by **Supabase Auth**; our **granular RBAC layers on top** (roles as claims/tables + NestJS guards). We own authorization; Supabase owns authentication.

**Status:** accepted · **Date:** 2026-07-08

## Decision

Build our **own granular roles/permissions system**. A small number of roles, but each with custom access to specific parts of the app, managed by a **super admin** who creates users and changes their permissions during operation. Do **not** use Chatwoot's Enterprise custom-roles code in production; use it as reference only.

## Context

- Free/core Chatwoot has only two roles: `agent` and `administrator` (binary). Not enough for the operator's need.
- Granular **custom roles** are an **Enterprise-licensed** feature (`enterprise/app/models/custom_role.rb`, controller, policy). We decided against any Enterprise/paid code.
- The `custom_role_id` column already exists in the free schema (a migration added it), so the data hook is present even though the logic is licensed.

## Why

- Operator's requirement (per-area access by role, super-admin-managed) maps exactly onto the Enterprise feature we're not using → we implement equivalent functionality ourselves.
- Aligns with the project stance: no dependency on Chatwoot licensing; rewrite under our own code.

## Consequences

- **Security ties:** SEC-2 (super-admin 2FA bypass) becomes mandatory to fix, since super admin is central. Role/permission changes must be written to our audit log (SEC-29).
- For single-tenant, platform `super_admin` and account `administrator` largely collapse — we'll define what "super admin" means in our system during role design.
- The detailed permission matrix (which roles, which app areas) is a **product-design task**, deferred. This decision only fixes the direction: our own RBAC, not binary, not Enterprise.
