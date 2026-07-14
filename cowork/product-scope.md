# Product Scope — Plan for Claude Code

> **This is a planning document, not an executed change.** Cowork does not modify `../chatwoot`. All "keep / remove / replace" below are **instructions for Claude Code** to carry out later in this repo, and a reference for future-chat migration. Nothing here has been cut.

## Product framing

- **Primary job: customer support** — omnichannel handling of inbound customer conversations. Reference product: **Zendesk**.
- **Future-proofing:** the operator expects scope to grow (possibly sales/pipeline or other). Chatwoot has **no** sales pipeline/deals — that would be *new build* later. So we keep the data model extensible (custom attributes, API channel, clean contacts/companies) rather than assuming support is the final scope.

## Keep — core support (non-negotiable)

Inbox / conversations, contacts, companies, agents / teams / assignment, macros, canned responses, automations, reports, notifications, settings.

## Channels

| Channel | Plan | Note |
|---------|------|------|
| Email | **Keep (now)** | Core support channel |
| **API channel** | **Keep (now) — PRIMARY intake, top priority** | The main entry point: ingests conversations from the **existing external AI widget (already works over API)** AND messenger messages that currently arrive via API. Prioritized above email in MVP. |
| **Web chat widget** (Chatwoot's own) | **Keep (now) — NEEDED** | Confirmed by Zendesk capture: 3 web widgets in use. Core channel. |
| **Mobile in-app chat (iOS + Android SDK)** | **Keep (now) — NEEDED** | Confirmed: iOS + Android apps use in-app messaging SDK. Chatwoot ships iOS/Android SDKs → keep/rebuild. |
| Messengers (WhatsApp, Telegram, FB, Instagram) | **Drop near-term** | NOT used in their Zendesk today. Revisit only if a real need appears. |
| SMS / telephony (Twilio) | **Future** | Not currently used; plan the seam. SEC-C2/C3 apply when enabled |
| TikTok, Twitter/X, LINE | **Remove** | Not used. |

> Updated 2026-07-09. Real channels, by priority: **API channel (primary — external AI widget + messenger traffic)**, web widget, mobile app SDK, email; heavy bot automation + agent escalation. Native messenger connectors are post-MVP (their messages already arrive via the API channel). See `zendesk-findings.md`.

## External AI note (important)

The company **already runs its own LLM widget** on the website answering customers. The CRM's role is to **capture those conversations as tickets via the API channel** — not to provide the AI. This is why Chatwoot's own AI (Captain) is not needed as-is.

## Optional areas — OPEN, decide later

Not yet decided (we are only discussing/documenting):

- **Help center / knowledge base** — Zendesk-style self-service; plausibly useful for support.
- **CSAT surveys** — post-conversation satisfaction; Zendesk has this.
- **Campaigns (outbound)** — more marketing than support.

## Replace / not inherited

- **Captain (Chatwoot's AI)** — not adopted as-is. If we want in-CRM AI later, we build our own (ties to decision on AI, still open). External LLM widget already covers front-line AI.

## Extensibility guardrails (for future growth)

- Preserve **custom attributes** on contacts/conversations.
- Keep the **API channel** as the general integration inlet.
- Keep contacts/companies model clean so a future **sales/pipeline** module can attach without rework.
