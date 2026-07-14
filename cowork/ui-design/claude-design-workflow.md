# Brandbook Workflow — Claude Design + Cowork

> How to build our brandbook (tokens, CSS, components, animations) using **Claude Design** (claude.ai/design) for the visual + **Cowork (this Claude)** for codifying it into our Vue/shadcn-vue system and Claude Code instructions.
>
> Target project: our support CRM — **white-label / multi-brand** (0028). Frontend = **Vue 3 + shadcn-vue + Tailwind** (decisions 0002/0025). Internal agent tool → density & usability first; branding is a swappable per-brand token layer (light + dark, switchable).

## The one rule that must not be broken

Claude Design's "best fidelity" design-system path is **React-oriented** ("best fidelity if you have React components"). We are **Vue**. So:

> **We consume Claude Design's VISUAL output and TOKENS — never its React code.** Cowork re-implements everything in shadcn-vue. Use the **"Create here"** path (Figma / assets / describe), not the Claude-Code-React path.

## Division of labor

- **Claude Design** = explore & generate the *look*: set up a **Design System** (brand source of truth) and generate **screens/blocks** (Prototype / Wireframe templates). Keeps outputs consistent + on-brand.
- **Cowork (me)** = *codify*: turn the look into **design tokens** (CSS variables), **shadcn-vue component specs**, **animation specs**, the **`brandbook.html/css`** deliverable, and **Claude Code instructions** to implement in this repo.

## Prerequisites — gather these once (brand inputs)

1. **No fixed logo** — product is white-label; use a neutral placeholder mark. Branding is per-brand config.
2. **Palette:** a pleasant neutral base (shadcn-like), NOT any one company's colors. Company colors are for infographics only, not the product theme (0028).
3. **Reference(s)** for inspiration (e.g. Refero styles — see `component-strategy.md`).
4. **3–5 adjectives** for the feel (e.g. clean / modern / trustworthy / fast).
5. **Theme:** **both light and dark, switchable** (required, 0028).
6. **Languages:** EN + ES (affects type choice + string lengths).

---

## Stage-by-stage plan

### Stage 1 — Set up the Design System in Claude Design
- Claude Design → **Design systems → Set up design system → "Create here"**.
- Feed it the brand inputs above (upload logo/assets, link Figma if you have one, paste the reference, describe the feel). Paste **Brief A** (below).
- Outcome: a reusable on-brand generator. Everything you generate next inherits it.
- **Hand to Cowork:** screenshots of the generated palette/typography/components, and any **exported CSS/tokens** if Claude Design offers export.

### Stage 2 — Cowork codifies the foundation (tokens)
- I turn Stage-1 output into **design tokens**: color palette + semantic roles (bg/surface/text/border/primary/success/warning/danger), typography (families, scale, weights, line-heights), spacing scale, radius, shadows/elevation, and **motion tokens** (durations, easings).
- Deliverables: `tokens.css` (CSS variables) + `tokens.json`, and a **live preview** here so you confirm they match Claude Design.

### Stage 3 — Generate key screens / blocks in Claude Design
- Using the design system, generate (Prototype/Wireframe) the core screens. Paste **Brief B** per screen. Priority screens:
  1. **Agent inbox** (left ticket list + center conversation + right contact panel).
  2. **Conversation view** (message thread, reply box, macros/canned, private notes, labels).
  3. **Dashboard / analytics** (branded charts area).
  4. Login, settings, contact profile.
- You can also generate **individual blocks** (buttons, ticket row, chat bubble, badges, modals) if you prefer block-by-block.
- **Hand to Cowork:** screenshots (and CSS/tokens export) of each screen/block.

### Stage 4 — Cowork codifies components + animations
- I map each screen/block to **shadcn-vue components** with our tokens, and write **component specs** (states, variants, spacing) + **animation specs** (what animates, duration, easing, trigger) implemented via CSS / `@vueuse/motion`.
- **Live preview** here to verify against Claude Design before locking.

### Stage 5 — Assemble the brandbook
- I compile everything into the deliverables:
  - `brandbook.html` + `brandbook.css` — the living, viewable brandbook (colors, type, components, motion, do/don't).
  - `tokens.css` / `tokens.json` — machine-readable tokens for the app.
  - `components.md` — shadcn-vue component specs.
  - `animations.md` — motion system.
  - **Claude Code instructions** — how to apply all of the above in this repo.

---

## Brief A — paste into Claude Design when setting up the Design System

```
Product: an internal support CRM — WHITE-LABEL, used under multiple brands. Audience: internal support agents (a dense, professional back-office tool), not customers. Bilingual UI: English + Spanish. Use a neutral placeholder brand, not any specific company's identity.

Feel: <3–5 adjectives, e.g. clean, modern, trustworthy, fast>.
Theme: BOTH light and dark, switchable.
Palette: a pleasant neutral base (shadcn-like); brand accent is a single swappable token.
References for inspiration: <Refero style links / screenshots> — take palette, typography and spacing rhythm as inspiration.

Build a design system with: color palette + semantic roles, typography scale, spacing, radius, shadows, and a component set suited to a high-density support desk (buttons, inputs, selects, tables/lists, cards, badges/status pills, tabs, modals, toasts, chat bubbles). Keep it clean and legible at small sizes.
```

## Brief B — paste per screen when generating

```
Using our design system, design the <SCREEN NAME> for an internal support CRM (Zendesk-like), Vue app, desktop-first.

Layout: <describe regions>. Example for the inbox:
- Left: ticket list (status pill, subject, requester, channel icon, time, unread).
- Center: conversation thread (customer left / agent right, private notes visually distinct), reply box with macros/canned-response and attach.
- Right: contact panel (player ID, VIP tier, custom attributes, past tickets).

Include realistic content (deposits/withdrawals/verification/bonus topics, EN+ES). Show states: hover, selected, unread, SLA-warning. Density: comfortable but information-rich.
```

## Handoff format (what to bring back to Cowork)

Best → good: (1) **exported CSS / design tokens** from Claude Design if available; (2) **Figma link** if used; (3) **screenshots** of screens/blocks + the design-system palette/type pages. Any of these works — I extract exact tokens from screenshots if needed.

## Notes
- The domain includes sensitive flows (account self-exclusion, KYC/verification) — flag those screens for clear, non-dark-pattern design.
- Chart library for branded analytics (0027) will be themed to these tokens (ECharts/Chart.js) in the UI build.
