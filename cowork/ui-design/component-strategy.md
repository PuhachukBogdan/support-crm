# UI Component Strategy — shadcn-vue as root, one consistent style

> Answers: "shadcn alone won't cover everything — fill gaps with other sources for ideas, but keep ONE consistent style (shadcn's or very close)." Proven model: **Supabase UI Library is built on top of shadcn/ui** (registry-compatible, same theming), extended with their own components.

## The core principle

Consistency does **not** come from "which library a component came from." It comes from a **shared visual layer**: our **design tokens (CSS variables) + Tailwind + the same primitive base (Reka UI)**. A shadcn component is literally just *Reka primitive + Tailwind + tokens*. So **anything we build with the same recipe is automatically on-brand and shadcn-consistent.**

> **Rule: take ideas from anywhere; the STYLE always comes from our token layer. Never drop in a pre-styled component kit that carries its own look — that's what breaks consistency.**

## Layered model

1. **Tokens** (`tokens.css` — CSS variables): the single source of visual truth (colors, type, spacing, radius, shadows, motion).
2. **Base components — shadcn-vue** (owned, copied in): buttons, inputs, selects, dialogs, dropdowns, tabs, popovers, toasts, tooltips, cards, badges, command palette, etc.
3. **Gap components — built by us** on **headless/unstyled libraries + Reka primitives**, skinned with our tokens (details below).
4. **Blocks & screens**: compositions of layers 2–3 (inbox, conversation, dashboard, auth…).

Everything reads Layer 1 → one coherent style.

## How to fill gaps (without breaking style)

Use **headless / unstyled** libraries (behavior only, no imposed look), then style with our tokens/Tailwind so they match shadcn:

| Need | Headless base (free) | Note |
|------|----------------------|------|
| Data tables (sortable/filterable) | **TanStack Table** (`@tanstack/vue-table`) | Headless; we render with shadcn table styles |
| Long lists (ticket list, 100k+) | **TanStack Virtual** (`@tanstack/vue-virtual`) | Virtualization for performance (372K tickets) |
| Rich reply editor / notes | **Tiptap** | Headless rich-text; style to tokens |
| Charts (analytics) | **ECharts** (`vue-echarts`) | Per 0027; theme to tokens |
| Date / date-range pickers | **Reka UI Calendar/DatePicker** | Same base as shadcn-vue |
| Drag & drop (kanban, reorder) | headless dnd (e.g. pragmatic-drag-and-drop / vuedraggable) | Behavior only; our styles |
| Command menu, combobox, toasts | **shadcn-vue** (has these) | Use directly |

For anything else: **compose from Reka UI primitives + Tailwind + tokens** ourselves.

## Ideas sources (for patterns, not code)

Look at shadcn/ui (React), Supabase UI, shadcn community registries/blocks, Origin UI, etc. for **interaction/layout ideas**, then **re-implement in our shadcn-vue style**. Their code (esp. React) is reference only.

## Our own internal registry (like Supabase)

Maintain an **internal component registry** in the repo: every component — base or gap-filler — lives in one place, reads the tokens, follows shadcn-vue conventions. This keeps the whole app reusable and uniform, and is exactly how Supabase scaled a large, authentic-looking set on a shadcn base.

## Governance (the one rule, restated)

Before any component enters the codebase: it must (1) read our tokens, (2) use Tailwind + Reka conventions, (3) carry no foreign/imposed CSS. Idea from anywhere → styling from our layer.

## Borrowing from style references (Refero etc.)

**Refero** (styles.refero.design) publishes per-style specs as **DESIGN.md + Tailwind config + CSS Variables + Design Tokens** (copy / download `.md`). This maps directly onto our token layer, so it's a first-class source of both ideas and tokens.

Two cases, handled differently:

1. **A whole style** → do NOT adopt wholesale. We maintain our own design system (white-label, 0028); adopting a foreign full style would fight it. Use only as **inspiration** for our own token choices, or a draft we adapt.
2. **A single effect / element** (e.g. a "bubble"/gradient-blob, glow, animation) → borrow freely, but:
   - Re-implement the **effect/technique** ourselves, **parameterized by OUR tokens** (our brand colors + motion tokens).
   - Package as an **isolated, reusable component** under `ui/decorative/` (kept separate from functional shadcn-vue components).
   - **Opt-in per screen**, never global (e.g. registration background, AI-panel accent).

**Dev process for an effect:** operator picks it on Refero → sends the `.md`/link/screenshot → Cowork extracts the technique, strips foreign brand specifics, rebuilds it as a token-driven Vue component + live preview → used only where chosen.

**Performance rule:** heavy effects (WebGL/canvas blobs, big animations) only on light screens (login, AI accents, marketing) — **never in the dense inbox** (372K tickets; speed + legibility win there).

## Sources
- Refero Styles (DESIGN.md / Tailwind / CSS vars / tokens per style): https://styles.refero.design
- Supabase UI Library (built on shadcn/ui): https://supabase.com/blog/supabase-ui-library , https://supabase.com/ui
- shadcn-vue: https://www.shadcn-vue.com/ , Reka UI: https://reka-ui.com/
