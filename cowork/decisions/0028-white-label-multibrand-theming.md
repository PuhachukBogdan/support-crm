# 0028 — White-label / multi-brand product; light+dark theming; company colors are infographic-only

**Status:** accepted · **Date:** 2026-07-09 · **Relates:** 0002, 0003, 0025, ui-design/*

## Decision

The product is **brand-independent (white-label / multi-brand).** It must not hardcode any single company's identity, so it can be used under **different brands inside the organization** and look authentic for each.

- **No fixed logo / company name** baked into the product. Branding (name, logo, colors) is a **swappable per-brand configuration** (token layer).
- **Theming via CSS variables** (shadcn-vue): each brand = a set of token values.
- **Light AND dark themes, switchable** (required).
- **The organization's corporate colors** (a green + dark teals) are **NOT the product theme** — reserved for infographics only. The product uses a **pleasant neutral base palette** (shadcn-like) with a single swappable brand-accent token.

## Why

- Operator's directive: independence from the company, reusable across brands, authentic per brand.
- Corporate colors are dark-only and not suited as a UI theme; shadcn's neutral palette + light/dark is nicer and more flexible.

## How it fits earlier decisions

- **0003 (account model kept as multi-tenant seam):** multi-brand maps onto per-account (or per-brand) theming/config — the seam already supports it.
- **0025 / shadcn-vue:** theming is already CSS-variable based → white-label is natural (swap token sets per brand).
- **Design bake-off (`../ui-design/design-lab-brief.md`):** mockups use neutral brand-agnostic palettes with a light/dark toggle, not company colors.

## Consequences

- Docs de-identified: company/brand names removed from `/cowork` files (kept functional domain facts only).
- Brandbook (built after the bake-off) defines a **neutral base + a documented "brand accent + theme" swap mechanism**, not one fixed brand.
- Per-brand config surface (name, logo, accent color, maybe locale) to be designed as part of settings.
