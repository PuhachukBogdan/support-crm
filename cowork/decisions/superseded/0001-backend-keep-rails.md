# 0001 — Keep Chatwoot's Rails backend; new code in TypeScript

> ⛔ **SUPERSEDED by 0022 (2026-07-08).** Ruby was ruled out (no maintainers). Backend is now rewritten in NestJS/TS; Chatwoot is a blueprint, not a fork. Kept for history.

**Status:** accepted · **Date:** 2026-07-08

## Decision

Keep Chatwoot's existing **Ruby on Rails backend** as our starting point and rework it in place. Write all **new** code — the frontend and any new features — in **TypeScript**. Do not rewrite the working backend into another language.

## Context

- The backend is ~52k LOC: 105 models, 202 services, 82 jobs, 143 migrations, 89 DB tables — mature, debugged domain logic (multi-tenancy, channel integrations, real-time, webhooks). This is the concentrated value of Chatwoot.
- We took a one-time copy with no upstream link, so all maintenance is ours regardless of language.
- Development is AI-assisted (Opus 4.8); the operator does not read backend code deeply.

## Why (the deciding arguments)

1. **Reuse is the whole premise.** Keeping the backend captures the "start closer to the finish" goal; rewriting discards exactly the hard, already-debugged part and reintroduces solved bugs (channel edge cases, tenancy invariants, race conditions).
2. **Verification, not typing, is the bottleneck in vibecoding.** A full rewrite = 52k fresh, unverifiable lines. Since we depend on AI either way, the safer path is the one with *less* AI-generated code to trust — that's keeping Rails.
3. **The "AI prefers TypeScript" benefit is already captured** by writing the frontend and new features in TS. It does not justify rewriting the working backend.
4. TS/JS has a marginally larger model-fluency and ecosystem edge, but Rails' strong conventions make AI-generated Rails reliable; the gap doesn't outweigh points 1–2.

## Consequences

- Two languages with a clean API boundary: Ruby/Rails (backend) + TypeScript (frontend + new features).
- Prefer adding new features into the Rails backend to avoid fragmenting it; spin up a separate TS/Python service only when a feature is genuinely separable (e.g. a future AI service).
- Rails currency becomes a standing obligation (ties to security SEC-8): we must upgrade off the EOL Rails branch and keep it patched ourselves.
