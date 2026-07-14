# Security Findings — Re-evaluated for Our CRM

> ⚠️ **Updated by pivot 0022 (2026-07-08).** Backend is rewritten in NestJS/TS. Rails/Devise/Rails-EOL-specific findings (e.g. SEC-1, SEC-2, SEC-8) are no longer bugs to patch — they become **"do not reintroduce"** requirements when we build the equivalent feature in NestJS. **SEC-8 (Rails EOL) is void.** Product/policy findings (retention, backups, audit, egress, PII-in-logs) are unchanged and still apply.
>
> **Status of this document:** working tracker. Source input is `../reference/chatwoot-security-report.md` (read-only static review of Chatwoot v4.15.1). That report is **input, not truth** — every item below has been re-judged for *our* scenario. Where our judgment differs from the report, the "Our call" column says so and why.

## Our scenario (the lens for every re-rating)

- **Internal CRM**, not a public multi-tenant SaaS. No public self-signup. Users are our own staff. This *lowers external attack surface* (bots, anonymous signup) but does **not** lower insider risk or compliance obligations — a CRM holds real customer PII either way.
- **One-time copy of Chatwoot, no upstream link (variant Б).** We will not pull future Chatwoot patches. Consequence: the *entire* security-patch lifecycle (Rails, gems, npm) is permanently ours. "Upstream will fix it later" is not available to us. This raises the weight of framework/dependency findings (#10, #14).
- **Heavy rework / possible service split.** We keep only a skeleton of the original. This is itself a risk: the parts the report calls *solid* (tenant isolation, RBAC/policies, SSRF protection, auth/JWT) are exactly the parts that are expensive to retrofit and easy to regress during aggressive refactoring. See `README.md` → "Must-not-regress invariants".

## Severity / rating legend

- **P0 – Blocker**: real company/customer data must NOT enter the system until this is Done.
- **P1 – Before production**: must be Done before internal go-live, not necessarily before the first test data.
- **P2 – Should**: fix during hardening; not a go-live gate on its own.
- **P3 – Backlog**: opportunistic / defense-in-depth.
- **COND – Conditional**: only applies IF we ship a specific feature/channel/integration (see Category 6).

Status values: `open` · `in-progress` · `done` · `n/a (rationale)`.
`CW#` = original finding number in the source report, kept for traceability.

---

## Category 1 — Real blockers before real company/customer data

These gate the moment real PII touches the system. All must be `done`.

| ID | CW# | Finding | Report sev | Our call | Why (our scenario) | Status |
|----|-----|---------|-----------|----------|--------------------|--------|
| SEC-1 | 1 | Unauthenticated direct file upload (auth check passes when request is anonymous) | Critical | **P0** — agree | Unauthenticated write into any account's storage. "Internal only" does not save us: any exposure (VPN misconfig, SSRF pivot, a single public endpoint) makes it live. Cheap fix. | open |
| SEC-2 | 2 | Super Admin login skips 2FA | Critical | **P0** — agree | You flagged this yourself: not a data-leakage bug, but it's password-only access to the highest-privilege role, which also unlocks the Sidekiq console (SEC-3). Real production risk. Keep as blocker. | open |
| SEC-3 | 13 | Sidekiq admin console reachable via super-admin session only | High | **P0** (tied to SEC-2) | Job payloads contain PII. Fix SEC-2 first, then network-restrict (VPN/IP allowlist) regardless. | open |
| SEC-4 | 3 | XSS in AI-assistant "@mention" rendering (bypasses sanitizer) | High | **P0 IF the mention/AI render path ships; else P1** | Reachable via customer-derived text. If we drop the Captain/AI feature (see SEC-C1) the *reported* trigger goes away — but the underlying unsanitized `markdownIt/link.js` render path should still be routed through the sanitizer, because it amplifies with SEC-24 (token in JS cookie) into full account takeover. Do not close by "we removed AI" without confirming the render path is gone. | open |
| SEC-5 | 4 | Password-reset links never expire | High | **P0** — agree | Account takeover from a single leaked/forwarded email. Trivial fix (enforce the 6h window that's already configured). | open |
| SEC-6 | 11 | Production DB password silently falls back to a public default | High | **P0** — agree | One forgotten env var = database with a well-known password. Fix = fail-closed on startup. This is both a code footgun and infra hygiene; we treat it as a blocker because it fails silently. | open |
| SEC-7 | 12 | HTTPS / secure-cookie not enforced by default | High | **P0** — agree | Session cookie can go plaintext. Must be on for any real deployment. | open |
| SEC-8 | 10 | Rails version past end-of-security-support | High | **P0** — agree, **and elevated in character** | Report treats this as a one-time upgrade. For us (no upstream) it is the start of a *permanent* framework-maintenance obligation. Running unpatchable framework code under real PII is not acceptable. Larger effort than the other blockers — plan it early. | open |
| SEC-9 | 14 | ~65 known-vulnerable frontend deps (2 critical, 26 high), incl. a direct HTTP client | High | **P0 for critical/high; P2 for moderate/low** | The direct HTTP client CVEs process attacker-influenced data — blocker. Again elevated in character: no upstream means we own the npm audit cycle forever. Establish a standing dependency-audit gate (see README). | open |

**Gate rule:** real data entry is blocked until every Category-1 item is `done` or a documented `n/a`.

---

## Category 2 — Important security fixes before production

Not necessarily gating the first test data, but required before internal go-live.

| ID | CW# | Finding | Report sev | Our call | Why (our scenario) | Status |
|----|-----|---------|-----------|----------|--------------------|--------|
| SEC-10 | 15 | Second (authenticated) upload path has no size/type validation; file links lack ownership check | Medium | **P1** | Authenticated-insider abuse + leaked-link = indefinite access. Standardize validation + ownership check across *all* upload paths (pairs with SEC-1). | open |
| SEC-11 | 27 | Auth token stored in a JS-readable cookie | Medium | **P1 — elevated** | Report calls it "design choice, recommended". We're building fresh: moving the token to an httpOnly cookie now is cheap and removes the XSS→takeover amplifier (SEC-4, SEC-13). Decide this early as an architecture choice, not a late patch. | open |
| SEC-12 | 24 | No Content-Security-Policy (present in code, disabled) | Medium | **P1** | Second layer against XSS. Given SEC-4/SEC-11, sanitization is currently the *only* layer — unacceptable. Turn on a baseline CSP. | open |
| SEC-13 | 30 | "Agent typing" indicator leaks private-note activity to the customer | Medium | **P1** | Real-time leak; the only guard is front-end display logic (bypassable). Apply the same private-exclusion rule already used for messages. | open |
| SEC-14 | 19 | No account lockout after repeated failed logins (rate-limit off outside prod) | Medium | **P1** | Rate-limit-only defense with an env-dependent switch is brittle. Add lockout independent of rate limiting. | open |
| SEC-15 | 18 | API access tokens never expire / no rotation | Medium | **P1 IF we expose the API / service integrations; else P2** | For internal service-to-service tokens, indefinite validity of a leaked token is a real exposure. Add expiry + rotation. | open |
| SEC-16 | 34 | High-volume write actions (records) not individually rate-limited | Low-Med | **P2** | A compromised low-trust account could burst-create. Add targeted limits. Not a go-live gate. | open |
| SEC-17 | 31 | Contact cross-account check lives in controller, not policy layer | Low | **P1 — elevated** | Report: latent, "No" blocker. For *us* the probability jumps: our heavy refactor is exactly the "future change that removes the controller guard" scenario. Push the check into the policy layer **before** we refactor contacts, plus a regression test. | open |
| SEC-18 | 33 | SQL filter-builder uses string interpolation, safe only due to an allow-list | Low | **P1 — elevated** | Same reasoning as SEC-17: safe *today*, one refactor away from SQL injection. Add tests guarding the allow-list before touching the query builders. | open |

---

## Category 3 — Deployment / infrastructure hygiene

Owned at deploy/ops level. Most are our responsibility permanently since we run our own infra.

| ID | CW# | Finding | Report sev | Our call | Why (our scenario) | Status |
|----|-----|---------|-----------|----------|--------------------|--------|
| SEC-19 | 25 | Containers run as root; prod image tagged `latest` | Medium | **P1** | Non-root user + pinned image tags. Cheap, standard, do it as we build our own deploy pipeline. | open |
| SEC-20 | 16 | No built-in DB backup tooling at all | Medium | **P1** (also Category 4) | For a CRM this is table-stakes ops, not optional. Encrypted dump to off-host storage; documented and tested restore. | open |
| SEC-21 | 42 | Two backend gems sourced from a moving branch, not a pinned release | Low | **P2** | Supply-chain reproducibility. Pin to a commit/tag as we lock our own Gemfile. | open |
| SEC-22 | 39 | No enforced DB-connection encryption; cache image not pinned | Low | **P2 (P1 if DB/cache move to separate hosts)** | Low risk single-host; becomes real once infra is split. Decide with the infra topology. | open |
| SEC-23 | 40 | Diagnostic preview page excluded in prod but not staging | Low | **P3** | Align exclusion to all non-dev environments. No sensitive data exposed. | open |
| SEC-24 | 35 | Debug logging shipped in the production frontend bundle | Low | **P3** | Strip in prod build. Minor info exposure. | open |
| SEC-39 | 45 | App sets no privacy/versioning options for cloud file storage — bucket privacy is entirely a deployment responsibility | Info | **P2** | Not a code defect, but with no application-level safety net a misconfigured public bucket = mass attachment leak. Document required bucket privacy settings for our chosen provider and verify at deploy. | open |

> `CW#17` (telemetry + push relay) is a deployment-level network decision but is primarily an external-data-flow issue → tracked in `external-data-flows.md`.

---

## Category 4 — Compliance / product requirements

These are product/policy decisions as much as code. For a CRM they are core, not "later" — pushing them past go-live is the most common under-rating, so treat them as first-class.

| ID | CW# | Finding | Report sev | Our call | Why (our scenario) | Status |
|----|-----|---------|-----------|----------|--------------------|--------|
| SEC-25 | 7 | No data-retention / cleanup policy (data kept forever) | High | **P1** | Direct retention-compliance gap for stored PII. Needs a configurable retention job *and* a written policy. Product decision on retention windows required. | open |
| SEC-26 | 20 | PII (emails, phones, message text) not scrubbed from logs; integration clients log full API responses on failure | Medium | **P1 — hard requirement before any centralized logging** | If we ever add log aggregation before fixing this, we mass-replicate PII (and possibly third-party tokens) into a new store. Fix before, not after. | open |
| SEC-27 | 21 | Contact export: non-expiring link, no audit trail, no rate limit | Med/High | **P1** | Full contact DB in one forwardable link with no trace. For a CRM, export governance is core. Link expiry + audit log + rate limit. | open |
| SEC-28 | 22 | Report / survey exports contain PII, no audit trail | Medium | **P2** | Same class as SEC-27, lower urgency (no non-expiring-link). Extend audit logging to cover them. | open |
| SEC-29 | 28 | No general audit trail; the paid-tier audit log has gaps and requires the Enterprise license | Medium | **P1 (decision) / build** | Tied to SEC-33. "Who viewed/exported this customer's data" is a baseline compliance question for an internal CRM. Since we're rebuilding under our own code, plan our own data-access + export audit log rather than depending on the licensed module. | open |
| SEC-30 | 41 | Account deletion not written to persisted audit trail (log only) | Low | **P2** | Part of the same audit-log build (SEC-29). Add an explicit entry. | open |
| SEC-31 | 44 | No formal data-portability / DSAR export feature | Info | **P3 (COND on compliance requirement)** | Build only if a concrete DSAR obligation lands. Note it now so it isn't forgotten. | open |
| SEC-32 | 46 | Two LGPL-3.0 dependencies (used unmodified) | Info | **P3** | Low risk; a brief legal sign-off is reasonable given possible future white-labeling. Not a blocker. | open |
| SEC-33 | 47 | Enterprise-licensed code (audit log, SSO, custom roles, billing) requires a paid subscription for **any** production use, incl. internal | Info / policy | **P0-decision** | Not a code bug but a real go-live gate. Decide: buy the subscription, or strip/rebuild these under our own code before production. This decision drives how SEC-29 is resolved. Must be decided before scope is locked. | open |

---

## Category 5 — Low-priority hardening backlog

Defense-in-depth. Schedule opportunistically; none gate go-live.

| ID | CW# | Finding | Report sev | Our call | Note | Status |
|----|-----|---------|-----------|----------|------|--------|
| SEC-34 | 37 | Minor crypto hygiene (non-crypto hashes for IDs, one non-constant-time compare) | Low | **P3** | Low exploitability. Address as we touch those utilities. | open |
| SEC-35 | 38 | Minimum password length is 6 | Low | **P3 (P2 if no SSO/MFA enforced)** | Raise to 8+. Cheaper win if we don't end up enforcing SSO/MFA org-wide. | open |
| SEC-36 | 43 | One unsanitized HTML render on the sign-up page (fixed string today) | Low | **P3** | Content is static now; migrate to the standard sanitizer for consistency. May become `n/a` if we remove public sign-up entirely. | open |
| SEC-37 | 36 | Some frontend libs (cookie handling, text rendering) have patched versions | Low-Med | **P2** | Folds into the SEC-9 dependency-audit pass. | open |
| SEC-38 | 32 | Recent search history persists in browser across logout | Low | **P3 (COND shared-desk — see SEC-C8)** | Leaks searched customer names/emails to the next user on a shared machine. | open |

---

## Category 6 — Feature / integration / channel-dependent

**Key principle:** if we don't ship the feature, the finding becomes `n/a` — and that's a *legitimate mitigation* (attack-surface reduction), not a dodge. Each item must be revisited when we decide whether that feature is in scope. Until scope is decided, treat "on" as the default and keep these `open`.

| ID | CW# | Finding | Applies IF we ship… | Report sev | Our call | Status |
|----|-----|---------|---------------------|-----------|----------|--------|
| SEC-C1 | 3 / AI rows | AI/Captain assistant: XSS render (SEC-4) **and** full conversation text + voice audio sent to a third-party LLM (+ LLM tracing) | The AI assistant feature | High / most-sensitive flow | **If shipped: P0.** This is the single most sensitive data channel in the system — complete customer conversations leaving to a third party. Treat enabling it as an explicit, documented business decision. If not shipped: `n/a` and confirm the render path (SEC-4) is removed. | open |
| SEC-C2 | 5 | SMS webhook accepts unsigned/forged requests | The SMS channel | High | **If shipped: P0.** Add provider signature verification. Else disable the route entirely (`n/a`). | open |
| SEC-C3 | 6 | Twilio Voice webhook accepts unsigned requests (Enterprise module) | The Voice channel | High | **If shipped: P0** + Enterprise-license implication (SEC-33). Else `n/a`. | open |
| SEC-C4 | 9 | Push/email notifications embed full message content | Push or email notifications | High | **If shipped: P1.** Customer message text lands on lock screens / personal email outside the CRM. Add a content-free notification option. | open |
| SEC-C5 | 8 | Conversation transcript can be emailed to any address, no ownership check | The transcript-email feature | High | **If shipped: P1.** Restrict destination and/or audit the action. | open |
| SEC-C6 | 23 | Webhooks deliver the entire record incl. hidden Cc/Bcc recipients | Outbound webhooks | Medium | **If shipped: P1.** Any admin-configured webhook = full PII read. Offer field-restricted payloads. | open |
| SEC-C7 | 26 | Cross-frame (postMessage) messages not origin-checked | The embeddable widget / dashboard-app frames | Medium | **If shipped: P1.** Verify sender origin. Else `n/a`. | open |
| SEC-C8 | 29 | Browser drafts + private notes persist across accounts, cleared only on explicit logout | Deployment on shared support-desk computers | Medium | **If that deployment model: P1.** Tie drafts to account/user; clear on session expiry. Pairs with SEC-38. | open |
| SEC-C9 | 17 | Error-tracking (e.g. Sentry) captures PII by default once enabled | Error tracking enabled | Medium | **If enabled: P1.** Turn off PII capture immediately. See `external-data-flows.md`. | open |

---

## Cross-cutting corrections to the report (where we deliberately diverge)

1. **"It's internal, so lower severity" — rejected for SEC-1/SEC-2.** Internal deployment lowers *anonymous external* surface, not insider misuse or the consequence of any single exposure. The two Criticals stay Critical.
2. **SEC-8 (Rails EOL) and SEC-9 (npm CVEs) are heavier for us than for the report's author**, who implicitly assumed upstream maintenance. With no upstream link, these become a standing program (framework upgrades + a CI dependency-audit gate), not one-off tasks.
3. **SEC-11, SEC-17, SEC-18 elevated** from the report's "recommended/No-blocker" because our aggressive rework materially raises their probability of becoming live bugs. Fix the latent ones *before* the refactor that would expose them.
4. **Category 4 is not "later".** The report scatters retention/backup/audit/export/logging across "recommended before/during customization". For a CRM these are core product requirements; we pull them forward and make them explicit owners.
5. **The report's headline "GO, architecture is sound, don't rewrite" cuts against our plan.** The sound parts are the expensive-to-retrofit ones. If we split services or rewrite heavily, we must actively protect tenant isolation / RBAC / SSRF / auth — see the must-not-regress invariants in `README.md`.
