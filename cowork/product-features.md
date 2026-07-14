# Product Features — Walkthrough (support/agent tools)

> Output of the product-features grill-me session. Per-feature disposition (keep / rework / drop) for Chatwoot's existing agent tools, plus captured new-feature ideas. Planning for Claude Code — nothing executed here.

## In-chat agent helpers — walkthrough

### 1. Canned responses (saved reply templates)
- **Disposition: KEEP as-is** (baseline, manual, useful without AI).
- Possible later improvement: categories + variable substitution (customer name, etc.).

### 2. Macros (one-click action bundles)
- **Disposition: KEEP the engine.** Design specific, practical macros **later**, once the feature set is settled (macros invoke other features, so those come first). Additional macros TBD.

### 3. Labels (conversation tags)
- **Disposition: KEEP** (definite). Filtering, reports, and automations depend on them.
- **Migrate existing labels from the company's current CRM**, and **add new ones** (e.g. channel type) to widen filtering for analytics.

### 4. Custom attributes (extra fields on contacts/conversations)
- **Disposition: KEEP** — also our extensibility hook (0006).
- **Mirror the company's Zendesk attributes and extend them.**

### 5. Private notes & @mentions
- **Disposition: KEEP both.** Standard internal collaboration. Security tie: private activity must not leak to the customer (SEC-13).

### 6. Conversation utilities (participants, search, shared files, contact panel)
- **Disposition: KEEP + improve.** Concrete improvements are mostly look/UX → design in the **UI/design session**, not ad hoc. Open invite for any specific must-have.

## Settings-level features — walkthrough

### 7. Inboxes & teams
- **Disposition: KEEP + improve** (improvements mostly UX → UI session).

### 8. Auto-assignment (routing new tickets to agents)
- **Disposition: KEEP — mirror the company's Zendesk routing logic** (confirm via Zendesk screenshots).

### Ticket identity & terminology (raised here)
- Match **Zendesk's ticket identifier format** (likely id–date–channel, TBC from Zendesk).
- Consider using **"ticket"** terminology (Zendesk term the team knows) instead of "conversation" in the UI. Confirm during UI/rebrand.

### 9. Automations (rule engine)
- **Disposition: KEEP the engine + improve.** Specific rules mirror/verify against Zendesk.

### 10. Reports / analytics
- **Disposition: KEEP baseline; analytics gets its own dedicated session.** Operator wants strong analytics.
- **Idea (AI phase, 0008):** LLM-based ticket classification into **categories AND sub-categories** for richer analytics. Cost caveat applies. Second concrete AI idea (after the reply-suggestion panel).

### 11. Integrations
- **API channel:** KEEP (mandatory — LLM widget, 0006).
- **Slack:** KEEP/enable (team notifications).
- **Webhooks:** KEEP the capability as a cheap generic event outlet, but don't over-invest — prefer building core integrations **natively** in the product; revisit whether webhooks are even needed once native scope is clear.
- **Google/Microsoft, Dialogflow, Linear:** not now (Dialogflow moot — external LLM). Enable later only if a concrete need appears.

## Core keeps (obvious — not debated)
- Contacts & companies (core CRM data).
- Ticket statuses (open / pending / resolved / snoozed).
- Priorities.

## Still open — optional areas (found, to decide later)
- **Help center / knowledge base** — now **leaning "needed"**: it's the source for the AI reply-suggestion idea. Decide with the AI plan.
- **CSAT surveys** — optional (Zendesk has it).
- **Campaigns (outbound)** — optional, more marketing than support.
- **SLA** — Zendesk feature; rebuild if wanted (was Enterprise, removed in 0012).
- **Agent bots** — likely no (external LLM covers front line).

## Cross-cutting flags

### Current CRM is Zendesk → replicate config + migrate data  ✅ CAPTURED 2026-07-09 → see `zendesk-findings.md`
> First Zendesk dump received and analysed. Concrete specs (channels, fields/taxonomy, tags/labels, 98 macros, triggers/automations, groups/roles, routing, views, SLA) are in `zendesk-findings.md`. Remaining to capture: drop-down option values for Form L1/L2/L3, any custom-role permissions. Business context now known: **~58 agents, 372K closed tickets, channels = web widget + mobile SDK + email** (product is white-label / multi-brand, 0028).

- The company **currently runs Zendesk**; operator has access.
- **Pattern observed:** for many features the answer is "same as Zendesk." So capturing the Zendesk config is a **key, near-term task that unblocks dozens of "decide later" specifics** (ticket ID format, attributes, labels, macros, routing, SLAs, views).
- **Action:** Cowork writes step-by-step instructions for the operator to capture their Zendesk setup (screenshots/exports). Operator provides them; Cowork turns them into concrete specs.
- **Data migration** from Zendesk (contacts, history, tickets) — address in the deployment/migration session (Zendesk export/API in, Chatwoot `data_import` to build on).

## Captured ideas (future — mostly AI phase, see 0008)

### AI reply-suggestion panel (operator's idea — priority)
- A panel beside the chat where an **LLM suggests replies based on the company knowledge base**.
- **Bucket:** AI phase (0008) — build our own, after skeleton. Not now.
- **Cost caveat:** every suggestion is an LLM call = ongoing cost; design with cost controls.
- **Dependency it exposes:** AI-suggested replies "from the knowledge base" require a **knowledge base** to exist → this pulls the **help center (currently optional/deferred)** toward "needed" if we want this feature. Decide help center with this in mind.
- UX (suggestions under the input, only at conversation start/end, etc.) is undecided — design properly in the AI phase, not ad hoc now.
