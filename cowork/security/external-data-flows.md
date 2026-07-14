# External Data Flows — Re-evaluated for a Data-In-House CRM

> Source: Section 3 (External Communications Map) of `../reference/chatwoot-security-report.md`, re-judged for our scenario. Our stated goal is that **customer/company data stays in-house by default**; anything leaving the environment must be a deliberate, documented decision — not a default we inherited from Chatwoot.

## Default posture

Deny-by-default for outbound data. Every destination below is either **kept**, **disabled by default**, or **allowed only after an explicit decision**. Because we run our own infra, the cleanest enforcement is a **network egress allow-list**: only the destinations we consciously keep can be reached outbound. That converts "did someone leave telemetry on?" from a code-audit question into an infrastructure guarantee.

## Flow-by-flow ruling

| Destination | Purpose | Data that can leave | Report rec | Our ruling | Tracker link |
|-------------|---------|---------------------|-----------|-----------|--------------|
| Vendor telemetry / version-check | Daily update ping + usage stats | Install ID, version, domain, account/user/conversation counts | Review/disable | **Disable + block at egress.** No complete documented opt-out exists, and with no upstream link we don't need version checks at all. | SEC (CW#17) |
| Vendor push-notification relay | Push delivery when no private push project set | Sender name + first part of message text | Disable | **Disable / self-host push.** Message text leaving by default is unacceptable. Configure a private push project or drop push. | SEC-C4 (CW#9), CW#17 |
| Vendor instance-registration / billing | Optional registration + paid-tier billing sync | Company/owner name, email, billing IDs | Review | **Disable.** Not relevant to an internal fork; tied to the Enterprise-license decision (SEC-33). | SEC-33 |
| Error-tracking service (e.g. Sentry) | Crash/error reporting | Stack traces **+ PII by default** once enabled | Require config | **Off by default. If enabled: turn off PII capture first**, scrub before send. | SEC-C9 (CW#17) |
| APM / performance monitoring | Perf metrics | Timing/perf data | Keep | **Allow (opt-in), internal ops only.** Low sensitivity; still put behind the egress allow-list. | — |
| Product analytics | Usage analytics | Email, name, events | No action (inactive) | **Keep disabled.** Confirm it stays off. | — |
| Bot-protection (captcha) | Protect public sign-up | Captcha token | N/A | **N/A** — public self-signup is disabled for an internal CRM. | (relates to SEC-36) |
| **AI / LLM provider ("Captain")** | Reply suggestions, summaries, voice transcription | **Full conversation text + voice audio** | Require config / business decision | **Highest-risk flow in the system. Off unless an explicit, documented business decision approves it.** If approved: data-processing terms, region, retention, and redaction must be settled first. | **SEC-C1** (CW#3 + AI rows) |
| LLM call-tracing service | AI debugging/tracing | Prompts/responses (i.e. customer data) | Review | **Off.** Same sensitivity as the LLM provider; do not enable tracing to a third party over real conversations. | SEC-C1 |
| Data-enrichment service | Enrich contacts at onboarding | Email address | Keep (opt-in) | **Allow only if a business owner opts in**; it still sends customer emails out — not free. | — |
| Payment processing | Billing/subscriptions | Payment/subscription data | Keep if paid tier | **N/A** unless we use paid billing (we likely won't for an internal tool). | SEC-33 |
| Messaging channels (WhatsApp, FB, IG, Slack, Telegram, SMS, Voice…) | Core send/receive of customer messages | Channel-specific message data, only after admin configures | Keep | **Allow per channel we actually ship** — this is the product working as intended. For each: scope + rotate credentials, and note the webhook-signature findings (SEC-C2, SEC-C3). | SEC-C2, SEC-C3, SEC-C6 |

## Notes for planning

- **The AI/LLM channel is the one to decide consciously.** Everything else is either core product (messaging channels) or noise we can switch off. Sending complete customer conversations to a third-party model is the single largest data-exfiltration surface in the whole system; it deserves its own decision record, not a config toggle buried in setup.
- **Egress allow-list is the backstop.** Even if a future code change re-enables telemetry, a network egress policy that only permits our chosen destinations prevents silent leakage. Document the allow-list alongside the deploy config.
- **Credential hygiene per channel:** each messaging integration's tokens/secrets should be scoped to least privilege and rotated on a schedule; a leaked channel credential is a direct data path.
