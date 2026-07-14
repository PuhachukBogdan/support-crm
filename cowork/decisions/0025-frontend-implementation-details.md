# 0025 — Frontend implementation details (Vue)

**Status:** accepted (accumulating) · **Date:** 2026-07-08 · **Relates:** 0002, 0022, 0024

Kept stack (already modern, no change): **Vue 3.5, Vite 6, Tailwind 3.4, vue-router 4, vue-i18n 9.**

## 1. State management — Pinia (no big-bang migration)

- **Target: Pinia** (official, modern, type-friendly). Vuex is legacy/maintenance-only.
- **New state → Pinia. Existing Vuex (269 files) migrated opportunistically when a store is touched.** No forced full rewrite.
- Rationale: optimal long-term direction with minimal immediate work; matches Chatwoot's own in-progress Vuex→Pinia migration (269 Vuex + 12 Pinia today).

## 2. Component / design-system foundation — deferred to the UI session

Decision on building the redesign (shadcn-vue + tokens vs from scratch, and how much to lean on `components-next`) is **deferred to the dedicated UI/design session**.

## 3. Frontend API-client layer — clean API, rewrite the layer (Option B)

- New NestJS backend exposes a **clean REST API**; we **rewrite the frontend's ~123 api-client modules** to match. **UI components (984) stay.**
- Rationale: don't chain the fresh backend to Chatwoot's legacy API quirks; the api layer is small vs the component tree, so rewriting it is bounded and yields a clean, maintainable contract.

## 4. TypeScript on the frontend

- **New frontend code in TypeScript** (starting with the rewritten api-client layer and new components); existing JS converted opportunistically when touched. No big-bang conversion.
- Shared types with the NestJS backend where practical.

## 5. Tests

- **Vitest** (+ Vue Test Utils) as the frontend test tool; tests co-evolve with code (same principle as the backend gate).
