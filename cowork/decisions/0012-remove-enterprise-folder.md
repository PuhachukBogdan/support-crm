# 0012 — Remove enterprise/ entirely (moot post-0022); rebuild wanted pieces ourselves

**Status:** accepted · **Date:** 2026-07-08 · **Relates to:** 0004 (own RBAC), 0008 (no Captain), SEC-29/SEC-33

## Decision

Delete the `enterprise/` folder (and its load hooks in `config/application.rb`) from the project. Any enterprise capability we actually want is **rebuilt as our own code**. The pristine reference stays in `../chatwoot`, so we lose no reference material.

## What enterprise/ contains, and our disposition

| Enterprise feature | Disposition |
|--------------------|-------------|
| Custom roles | **Rebuild ourselves** (0004) |
| Audit log | **Rebuild ourselves** (SEC-29) |
| SLA (service-level agreements) | **Rebuild later if wanted** — legit Zendesk-like support feature; flagged so it isn't forgotten |
| Captain (AI) | **Drop** (0008) |
| SSO / SAML | **Drop** — internal CRM with our own RBAC; not needed |
| Billing | **Drop** — internal tool |
| Voice channel | **Future** channel (0006) — rebuild if/when voice is added |

## Why

- Licensing: enterprise/ is under Chatwoot's commercial license; keeping it even "as reference" in our shipped repo is legally murky. Removing it is clean.
- The reference isn't lost — `../chatwoot` (untouched, 0009) still has it to consult.
- Coupling is via conditional `Enterprise::` module `prepend`s + `eager_load_paths`; removing the load paths degrades gracefully, and the RSpec suite (0011) catches anything that breaks.

## Consequences

- `custom_role_id` column already exists in core schema — our own RBAC can reuse it rather than re-adding.
- Rebuild list (own code): RBAC (now), audit log (before real data), SLA (optional later).
