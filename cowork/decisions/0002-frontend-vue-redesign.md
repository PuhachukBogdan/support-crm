# 0002 — Keep Vue frontend; deep redesign with our own design system

**Status:** accepted · **Date:** 2026-07-08

## Decision

Keep Chatwoot's **Vue** frontend and perform a **deep redesign** (brand, animations, layout, component appearance) on top of it, using our own design system. Do **not** rewrite the dashboard in React/shadcn.

## Context

- Agent dashboard = **984 Vue files**; customer widget = 46; help-center portal = 5.
- Frontend is a Vue SPA talking to the Rails backend via API (123 API modules, axios) — a clean, decoupled boundary.
- Operator wants far more than a recolor: brand book, custom animations, changed object appearance and layout.

## Why

1. **UI depth is independent of framework.** Vue can do any animation, layout, or custom component React can. The visual ceiling is the same.
2. **A deep redesign in Vue reuses all the plumbing** (API calls, state, real-time, i18n, component logic) — we change templates, styles, layout, animations. A React rewrite throws the plumbing away too and re-implements logic/state/API for all 984 screens.
3. **Consistency with 0001:** we declined to rewrite the 52k-LOC backend because large rewrites are slow and unverifiable under vibecoding; the 984-file frontend is an even larger rewrite — the same logic applies.
4. **The shadcn aesthetic is available in Vue** via `shadcn-vue` (Radix Vue based); animations via `@vueuse/motion` / GSAP. We lose nothing visually by staying on Vue.
5. Preserves reuse of the chat window, which a React rewrite would void.

## Consequences

- Design docs target **Vue + Tailwind + shadcn-vue**, not React/shadcn. The `04-ui-design/` folder's `shadcn-reference.md` becomes a Vue-oriented design-system reference.
- Chatwoot already uses Tailwind and has an in-progress UI refresh (`components-next`) — our design system builds on that rather than fighting it.
- A reference site (to be provided) will inform the design phase, which comes after architecture. Its stack does not dictate ours.
- React remains a possible *later* migration, incrementally, only if a concrete need appears; not planned now.
