# shadcn/ui — Deep Analysis (and how we use it: shadcn-vue)

> The reference the operator pointed at (ui.shadcn.com). Verdict: ideal foundation, **free/MIT**, and we adopt its Vue equivalent **shadcn-vue** (already chosen in 0002).

## What shadcn/ui actually is (mental model)

- **Not a framework or a runtime dependency you're locked into.** It's a **code-distribution model**: a CLI (`npx shadcn@latest add <component>`) **copies the component's source code into your repo**. You then **own and edit** that code. "Open Code."
- Built on: **Radix UI** (headless, accessible primitives) + **Tailwind CSS** + small utils (`class-variance-authority`, `clsx`, `tailwind-merge`). Those are normal npm deps — all free/open — but there is **no "shadcn" library** you depend on.
- Offers: **components** (dialogs, dropdowns, tables, forms, popovers, toasts…), **blocks** (auth, dashboards, sidebars — larger compositions), **charts**, and docs.

## Cost / license (the operator's key question)

- **Free. MIT-licensed.** Commercial use allowed, **no attribution required**.
- Analogy to numpy holds (free + open-source) — and it's even more "ours": the code lives in our repository, **zero vendor lock-in, no paid tier.**
- → This materially **simplifies our UI/UX work.**

## The caveat: React → we use **shadcn-vue**

- ui.shadcn.com is **React**. We are **Vue** (0002/0025), so we cannot use it directly.
- We use **shadcn-vue** (`unovue/shadcn-vue`): the community Vue port, **MIT/free**, same "copy-paste, you own it" philosophy, built on **Reka UI** (formerly Radix Vue) + Tailwind, themed the same way (CSS variables).
- This is already our decision (0002). Everything the operator likes about shadcn/ui transfers.

## Brand customization (the operator's other ask) — YES

- Theming is via **CSS variables + Tailwind tokens**. Define brand values once — e.g. `--primary`, `--background`, `--foreground`, `--radius`, etc. — and **all components adopt the brand instantly.**
- **Dark/light** via a root class. Fully editable because we own the code.
- This is exactly where our **brand tokens** (from the Claude Design workflow) plug in: our `tokens.css` = the CSS variables shadcn-vue reads.

## Honest limitations of shadcn-vue (vs the React original)

- Community-driven and **less complete**: **fewer prebuilt blocks and charts**, smaller ecosystem, occasionally lags the React version.
- Implications for us:
  - **Core components:** available — use directly.
  - **Blocks** (auth, sidebar, dashboard layouts): fewer prebuilt — we assemble some ourselves from components (still cheap, since we own the pieces).
  - **Charts:** React shadcn charts = Recharts (React, not usable). For us, analytics charts follow **0027** (ECharts/Chart.js themed to our tokens); shadcn-vue charts are optional if/when suitable.

## Should we switch to React because the original is more complete? — No (recommended)

- The maintainability principle that ruled out Ruby applies: **the team knows Vue** (0025). Switching to React to get the richer shadcn/ui would repeat the "no one to maintain it" mistake and discard Chatwoot's Vue plumbing (984 components' logic/state/API/i18n).
- shadcn-vue covers the need. **Stay Vue + shadcn-vue.** Revisit only if the team can actually own React.

## How it fits our brandbook workflow

1. **shadcn-vue** = our owned component foundation (copy in what we need).
2. **Brand tokens** (CSS variables) = the theming layer — from the Claude Design visual (see `claude-design-workflow.md`).
3. **Claude Design** = generate the visual/screens; its React blocks/charts are **visual reference only**, not code we import.
4. **Cowork** = codify into shadcn-vue components + `tokens.css` + `brandbook.html/css` + Claude Code instructions for this repo.

Net: "replicate shadcn without depending on it" is literally how shadcn works — **we own the code.**

## Sources
- shadcn/ui license (MIT): https://github.com/shadcn-ui/ui/blob/main/LICENSE.md , https://github.com/shadcn-ui/ui
- "Is shadcn/ui free": https://www.shadcndesign.com/blog/is-shadcn-ui-free
- shadcn-vue (Vue port, MIT): https://github.com/unovue/shadcn-vue , https://www.shadcn-vue.com/
- Reka UI (ex Radix Vue): https://github.com/unovue/reka-ui
