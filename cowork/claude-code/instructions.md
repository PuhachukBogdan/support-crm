# Claude Code — Operating Instructions

> How to work in this repo. Root rules: `../../CLAUDE.md`. Roadmap: `../plan.md`. Rationale: `../decisions/`.

## Start of every session
1. Read the root `CLAUDE.md`.
2. Skim `cowork/00-project-context.md` (where we are).
3. Open `cowork/plan.md`, find the next `[ ]` point.
4. For that point, read **only** the doc(s) the root routing table sends you to. Don't load the whole knowledge base.

## Work protocol (strict)
- **One `plan.md` point at a time.** Mark it `[~]` when you start, `[x]` when done.
- Keep the change **scoped to that point.** No opportunistic refactors outside it.
- **Report completion** with: what changed, the test added, and the point id. Then stop and wait for the go-ahead to the next point.
- If a point is bigger than expected, split it into sub-points in `plan.md` rather than doing a big uncontrolled change.

## Definition of done (per point)
1. Code change implemented in this repo — the product (never in `../chatwoot`).
2. A **test that fails without the change and passes with it** (Jest for api, Vitest for web).
3. Whole test suite green.
4. `plan.md` status updated + one-line note.
5. For security-relevant work, reference the `SEC-##` id; for architecture, the ADR number.

## Non-negotiables
- **Never modify `../chatwoot/`** — read-only reference. Its `*.upstream.md` are upstream; ignore for our decisions.
- **Security gate:** no real customer/company data until all Category-1 items in `../security/findings.md` are `done` (plan Phase 11.1).
- **Must-build-correctly invariants** (`../security/README.md`): tenant/account isolation, RBAC in the policy/guard layer, SSRF protection, sound auth (no MFA bypass), **no PII in logs**. Add a regression test whenever you touch these.
- **White-label (0028):** never hardcode a brand. Colors/name/logo come from CSS-variable tokens + per-brand config.
- **Data stays in-house:** don't add outbound calls except to destinations on the egress allow-list (`../security/external-data-flows.md`).

## When blocked or unsure
- If a decision is missing or ambiguous, **stop and surface it** (don't silently improvise). Check `../decisions/` first; if truly undecided, ask.
- Prefer the smallest change that satisfies the point.

## Commits / PRs
- One PR per point (or a few tightly-related points). Title references the `plan.md` point id (and `SEC-##`/ADR where relevant).
- CI (lint + tests + npm audit) must be green before merge; deploy is automatic on merge to `main` (0026).

## Review workflow (coder + reviewer)
Optional but recommended: run a **reviewer pass** on each point (a review subagent, or a dedicated review step) that checks the diff against a **concrete checklist**, not vibes:
- correctness + the point's *Done when* criteria;
- security invariants (`../security/README.md`) + relevant `SEC-##`;
- performance (`../performance.md`) — queries/indexes, N+1, pagination, list virtualization;
- scope (no changes outside the point).
The reviewer returns specific, actionable fixes ("change X to Y because Z"); the coder applies them. Keep it lightweight — the objective ground truth is still the **tests + these docs**, not the reviewer's opinion. Don't over-orchestrate (one coder + one reviewer is enough).

## Projects
- `.` (repo root) — the product; this is where plan.md work happens.
- `../design-lab` — throwaway design bake-off only (`../ui-design/design-lab-brief.md`); do not build product logic there.
