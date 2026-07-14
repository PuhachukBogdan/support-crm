# 0026 — Deployment details

**Status:** accepted (accumulating) · **Date:** 2026-07-08 · **Relates:** 0007, 0016, 0022, 0023, SEC-6/7/19/20

## 1. Environments

- **local dev + production** now. **staging added later** when real users make prod-testing risky.
- Rationale: solo/early stage — three environments up front is unnecessary overhead.

## 2. Runtime + reverse proxy + HTTPS

- **Single server, Docker Compose** (per 0007): containers for NestJS API, built Vue static, self-hosted Supabase stack, Redis.
- **Caddy** as reverse proxy: routes `/` → Vue, `/api` → NestJS; **automatic HTTPS** (Let's Encrypt) — closes SEC-7 with minimal config. (nginx+certbot was the alternative.)

## 3. CI/CD — GitHub Actions, agent-triggerable auto-deploy with a test gate

- **GitHub Actions** (easier for a beginner + AI-familiar). Pipeline: push/merge to `main` (or manual "deploy" workflow) → **run tests (Jest/Vitest gate)** → build Docker images → deploy to the server.
- Goal: operator/Claude Code just says "deploy" (= merge to main / trigger workflow); **no manual SSH or manual prod uploads**. The test gate protects prod from bad builds.
- One-time setup: give CI deploy access to the server (SSH key/token in CI secrets).

## 4. Secrets

- Project committed to **GitHub**; that repo is deployed (operator's familiar flow, like his TG bot).
- **`.env` in `.gitignore`** — never committed. Secrets live in **GitHub Actions secrets** (for deploy) + **env files on the server**.
- **All default secrets changed** (SEC-6). Dedicated secrets manager (Vault) deferred — overkill for solo now.

## 5. Monitoring

- **Structured app logs** (PII-scrubbed, SEC-26).
- **Alerts to the operator's Slack DM** (uses Slack from 0021), **no spam**: only warn/error+ severity, dedupe/group duplicates, rate-limit.
- Heavier tooling (GlitchTip error tracker, Uptime Kuma) optional later. (Vendor/cloud telemetry + Sentry-with-PII stay disabled per 0020.)

## 6. Data migration from Zendesk (task, not decided here)

- Migrating Zendesk data (contacts, history, tickets, + config: attributes/labels/macros) into the new system is a **separate task that depends on the Zendesk config-capture** (0021). Sequence: capture Zendesk → map to our schema → import. Do before go-live with real data.
- **Update (2026-07-09, from capture):** Zendesk **UI export is unavailable** (no Account→Tools/Reports — plan/permission). **Migrate via the Zendesk REST API** (`/api/v2/`). Volume is large (**372K tickets**) → paginated/batched export. Next: Cowork writes the concrete API pull commands. See `../zendesk-findings.md`.

