# Design Lab — Brief for Claude Code (design bake-off)

> **Goal:** build a proper design bake-off — the **same screen** in **6 distinct, polished design directions** so the CEO picks one. Real **Vue 3 + Vite + Tailwind + shadcn-vue** components (NOT a color-swapped HTML template). Each direction genuinely different in layout density, type, spacing, motion — not just palette.
>
> **Where:** `../design-lab/` (fresh Vite + Vue + Tailwind + shadcn-vue project). **Throwaway** — exploratory, not the product; don't build product logic here. But it must look **production-quality visually**.
>
> **Read first:** `decisions/0028` (white-label, light+dark), `0002`/`0025` (Vue + shadcn-vue), `ui-design/component-strategy.md`, `ui-design/shadcn-analysis.md`, `zendesk-findings.md` (content realism).

## The screen (same for all 6)
**"Open ticket"** — 3 columns: ticket list (left) · conversation thread + composer (center) · contact panel (right). Include: status pills, SLA indicator, channel tags, private note (visually distinct), typing indicator, macros/canned bar, contact attributes (Player ID, KYC, PSP, VIP tier). Content **brand-neutral**, realistic support domain (deposits/withdrawals/verification/VIP/bonus), mixed **EN + ES**. **No company name/logo** (white-label, 0028) — use a neutral placeholder.

## Style source of truth (read these, don't invent)
The 5 Refero style specs live in **`../..../design-lab/refero-styles/`** — see its [`README.md`](../..../design-lab/refero-styles/README.md). Each style folder holds the downloaded `DESIGN.md` (+ `css-variables.css` / tokens). **Read the file(s) in each folder and reproduce those specs**, neutralized to a brand-agnostic palette per 0028. Do not fabricate tokens when a spec file is present.

## The 6 directions
Each = its own **token set (CSS variables) + shadcn-vue theming + signature layout/motion touches**, with **light + dark** and tasteful **micro-animations** (message rise, hover, typing dots, theme/style transitions). Refero styles are **inspiration** — adapt to **neutral brand-agnostic palettes**, don't copy wholesale (0028/component-strategy).

1. **Aurora (our own)** — clean modern shadcn default feel; neutral slate + one fresh accent; balanced density. The "safe modern" baseline.
2. **Family** — warm "command center"; soft rounded, warm neutrals, a serif display for headings; calm, human. Ref: https://styles.refero.design/style/1bcae895-2245-4d33-aa43-1c1e80719554
3. **Dub** — electric blueprint on matte; crisp, technical, subtle grid background, mono labels, low radius. Ref: https://styles.refero.design/style/b0d80806-b724-4ed1-a1d1-074edd3c9bc9
4. **Linear** — dark premium "cockpit"; refined, low-contrast surfaces, subtle glow/gradient, tight spacing. Ref: https://styles.refero.design/style/90ce5883-bb24-4466-93f7-801cd617b0d1
5. **Ventriloc** — architectural blueprint on white; thin precise lines, mono uppercase labels, near-zero radius, lots of whitespace. Ref: https://styles.refero.design/style/f99aca3e-5289-4595-a7cc-77a72052f4b8
6. **zkPass** — warm CRT terminal on cream; monospace, retro, scanlines, boxy; phosphor accent. Ref: https://styles.refero.design/style/3a398f82-579e-4ec4-a442-9962bf007edf

## Requirements
- Built from **real shadcn-vue components** (Button, Input, Card, Badge, Tabs, Tooltip, DropdownMenu, ScrollArea, Avatar, etc.), restyled per direction via tokens — demonstrate the actual component system, not fakes.
- A **direction switcher** + **light/dark toggle** to compare live.
- Each direction distinct beyond color: type scale, radius, density, shadows/borders, motion, and 1–2 signature touches (e.g., Dub grid bg, Linear glow, zkPass scanlines, Ventriloc hairlines, Family serif+rounded).
- Performant, no heavy WebGL; animations subtle (respect `prefers-reduced-motion`).
- Keep it to this one screen; don't wire real data or auth.

## Output
- A running `../design-lab` app; instructions to launch.
- Screenshots of all 6 directions (light + dark) for the CEO to choose.

## After the CEO chooses
The winning direction's tokens + component styling **graduate into the product** (this repo) as `tokens.css` + the brandbook (Cowork codifies), per `plan.md` Phase 7 and `ui-design/claude-design-workflow.md`.
