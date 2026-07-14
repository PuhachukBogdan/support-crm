# 0023 — DB platform: self-hosted Supabase (Postgres + Auth + Storage), NestJS is the brain

**Status:** accepted · **Date:** 2026-07-08 · **Relates/updates:** 0004, 0007, 0022

## Decision

Use **self-hosted Supabase** as the platform for **database (Postgres) + auth/accounts + file storage**. **NestJS remains the primary business-logic layer, public API, and security boundary.** Other Supabase parts (auto-API, its realtime) only if genuinely convenient and safe — not forced.

## Why (objective, for this project's reality)

- The build is effectively **solo + AI-assisted**, and the builder works directly with the DB. **Developer convenience is a real productivity multiplier for one person** — a legitimate, high-weight factor.
- Self-hosted → **data stays in-house** (satisfies 0007).
- Using Supabase's **maintained auth** is often **safer than hand-rolling** auth solo (auth is easy to get wrong).
- It's Postgres underneath → NestJS + our data access work normally.

## Honest downsides accepted (from the rational review)

- More operational surface (~10 services to run/patch/secure) than plain Postgres.
- Risk of "two paths to data" (auto-API vs NestJS) — contained by the guardrails below.
- RLS misconfiguration and default-secret exposure are real footguns — mitigated below.

## Non-negotiable guardrails

1. **RLS ON** for tables holding customer data — safety net even if something is accidentally exposed.
2. **Do not expose the auto-API (PostgREST) publicly** for sensitive data; the public entry point is the **NestJS API**.
3. **`service_role` key server-side only** (NestJS) — never in the frontend.
4. **Change ALL default secrets** (JWT secret, Postgres, Studio); **Studio/Kong behind firewall**, never public (our SEC-6 discipline).
5. **Chat realtime + private-note logic live in our NestJS WebSocket** (SEC-13), not raw Supabase DB-change broadcast.

## Ripples to other decisions

- **0007** — DB is now **self-hosted Supabase Postgres** (+ Redis for BullMQ still ours). Self-host/Docker stance unchanged.
- **0022** — auth changes from "Passport/JWT" to **Supabase Auth (GoTrue)**; NestJS validates Supabase JWTs.
- **0004** — our **granular RBAC layers on top of Supabase Auth** (roles as claims/tables + NestJS guards); Supabase Auth handles identity/login, we handle authorization.
