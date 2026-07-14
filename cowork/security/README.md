# Security — Domain Index

> ⚠️ **Updated by pivot 0022 (2026-07-08).** The backend is now **rewritten in NestJS/TS**, not forked from Rails. So security changes character: we **build these in from the start** rather than patch Chatwoot's bugs. Rails-specific findings (SEC-1 direct_uploads, SEC-2 Devise super-admin, SEC-8 Rails EOL, etc.) become **"do not reintroduce"** requirements in the rewrite (SEC-8 is void). The **principles/invariants below still fully apply** to the new NestJS backend and the kept Vue frontend.

This folder is our security interpretation of the Chatwoot base, re-evaluated for our own internal CRM. It is planning/reference material for Claude Code; it is **not** the upstream Chatwoot security posture and it treats the source review as input, not truth.

## Files in this domain

| File | What it holds | Read it when… |
|------|---------------|---------------|
| `findings.md` | All 47 findings re-judged into 6 practical categories, with our ratings (P0–P3 / COND) and status | You are implementing or planning any fix, or checking what gates real data |
| `external-data-flows.md` | Every outbound destination (telemetry, AI/LLM, push, error-tracking, channels) with a keep/disable/decide ruling | You touch integrations, notifications, telemetry, AI, webhooks, or deploy egress config |
| `README.md` (this file) | Scenario assumptions, must-not-regress invariants, and how Claude Code uses these docs | Start here; read once per security-related task before opening the others |

Input source (reference only, do not treat as final): `../reference/chatwoot-security-report.md`.

## Scenario assumptions (the lens)

1. **Internal CRM**, our own staff, no public self-signup. Lowers anonymous external surface; does not lower insider risk or compliance duty.
2. **One-time copy of Chatwoot, no upstream link.** The full patch lifecycle (Rails, gems, npm) is permanently ours.
3. **Heavy rework, possible service split.** The parts the report calls "solid" are the expensive-to-retrofit parts — protect them (see invariants below).
4. **Data stays in-house by default.** Outbound data is a deliberate decision, enforced by an egress allow-list.

## Must-not-regress invariants

Under the 0022 pivot these flip from "must-not-regress" (in a fork) to **"must-build-correctly"** (in the NestJS rewrite). They are the hardest things to get right, so the new backend must implement each deliberately, with tests:

- **Tenant / account isolation.** Cross-account data access stays blocked. Note SEC-17: push the check into the policy layer, not just the controller, *before* refactoring contacts.
- **RBAC / authorization policies.** Role checks live in the policy layer and are enforced, not assumed by the UI.
- **SSRF protection on outbound requests.** Do not bypass the existing outbound-request guard when adding integrations.
- **Auth / JWT / MFA design.** Don't introduce new session or token paths that skip existing checks (this is exactly how SEC-2 happened upstream).
- **Real-time privacy.** Private/internal notes are withheld from customer-facing WebSocket connections (see SEC-13 for the one place this leaks today).
- **SQL parameterization.** Keep queries parameterized; SEC-18 is the one fragile spot to guard before refactor.

If a task would change any of the above, that's a stop-and-flag moment, not a routine edit.

## How Claude Code should use these documents

This is the intended workflow for the later implementation phase. It keeps context small: read the index, pull only the relevant finding, do the work, update status.

1. **Entry point.** Before any security-related change, read this `README.md` and the specific `SEC-##` row(s) in `findings.md`. Do **not** load the whole security folder or the source report by default — pull only the finding(s) the task touches. The root `CLAUDE.md` (added later) will route here.
2. **Reference by ID.** Every fix references its `SEC-##` (and the original `CW#`) in the commit/PR/notes, so traceability back to this tracker and the source review is preserved.
3. **Respect the gate.** No task may introduce a path for real company/customer data until **all Category-1 (P0) items are `done`** or carry a documented `n/a`. Treat this as a hard precondition, not a guideline.
4. **Definition of done for a security fix:**
   - code/config change made;
   - a regression test that fails without the fix and passes with it (especially for the must-not-regress invariants);
   - the `SEC-##` status in `findings.md` updated (`open` → `done`), with a one-line note on what changed;
   - a short entry in the decisions log (once `/cowork/decisions/` exists) for anything that was a judgment call (e.g. dropping a feature to mark a finding `n/a`).
5. **Feature-dependent findings (Category 6).** When planning any feature, channel, or integration, first check whether a `SEC-C#` applies. If we decide not to ship that feature, mark the finding `n/a` **with the rationale** — that is a valid attack-surface-reduction mitigation. If we do ship it, its listed rating applies and must be satisfied before that feature goes live.
6. **Ongoing programs (because there is no upstream).** Two findings are not one-off fixes but standing obligations Claude Code should encode into CI/process:
   - a **dependency-audit gate** (npm + bundler audit) that fails the build on new critical/high CVEs — the durable form of SEC-9;
   - a **framework-currency policy** so we don't drift back onto an EOL Rails branch — the durable form of SEC-8.
7. **External data flows.** Any change to integrations, notifications, telemetry, AI, or webhooks must be checked against `external-data-flows.md` and must not open an outbound path that isn't on the egress allow-list.

## Open decisions this domain is waiting on

- **SEC-33 — Enterprise-license question.** Buy the subscription vs. strip/rebuild audit-log/SSO/roles under our own code. Blocks go-live and determines how SEC-29 (audit trail) is built. Decide before scope is locked.
- **SEC-C1 — AI/Captain assistant.** Ship it (and accept full conversations going to a third-party LLM, with terms/region/retention settled) or drop it. Highest-sensitivity data flow; deserves its own decision record.
- **Retention windows (SEC-25)** and **shared-desk deployment model (SEC-C8)** — product/ops decisions that change several ratings.
