# Zendesk Capture — Findings & Specs

> Synthesis of the operator's Zendesk dump (`_archive/zendesk-capture-raw/Zendesk Capture.pdf` + `_archive/zendesk-capture-raw/ticket-fields.csv`). Turns the capture into concrete specs and flags what it changes in our decisions. Screenshots were image-only; extracted via render + read.

## Big picture (new, important context)

- **Deployment domain (from the current Zendesk):** high-volume online consumer support — payments/accounts business. Multilingual (English + Spanish, e.g. "¿En qué podemos ayudarte?", "Bienvenida", "Cierre"). *(Company branding intentionally omitted — product is white-label / multi-brand, 0028.)*
- **Scale is large:** **372.6K closed tickets**, ~**58+ agents**, deposit tickets dominate (3K in progress, "Deposit requests" group = 43 agents). Performance/indexing matters; this is not a tiny internal tool.
- **Regulated domain:** KYC/verification, payments (PSPs: Directa24, PayCord, Payment Gateway, Transaction/PSP IDs), and **account-safety flows** (self-exclusion, harm-related account closures). → **Compliance (retention, audit, data-subject handling) is heavier than a generic internal CRM** — re-elevates 0015 (retention) / DSAR / 0019 (audit).

## Channels (corrects 0006's assumption)

Active messaging channels are **their own apps + web**, not the messenger-heavy set I assumed:

- **Web chat widget** ×3 (Web Widget).
- **Mobile in-app chat**: Android app (Android SDK) + iOS app (iOS SDK).
- **Email** (views show email tickets).
- Heavy **bot automation + escalation** ("Bot Managed" 2.3K, `bot_managed`/`bot_escalation` tags) — fits their external LLM widget.

**→ Decision update (0006):** Chatwoot's **web widget is NEEDED (not optional)**, and we also need **mobile SDK (iOS/Android) in-app chat** — Chatwoot ships these SDKs, so keep/rebuild them. The API channel (for the external LLM) stays mandatory. WhatsApp/Telegram/etc. are NOT currently used — drop from the near-term plan.

## Ticket fields → custom attributes + analytics taxonomy (⭐)

From `ticket-fields.csv` (~65 fields). Standard: Assignee, Group, Priority, Status, Type, Subject, Description. **Custom, notable:**

- **Hierarchical topic taxonomy already exists:** `Form L1 - {Account, Deposits, General, Issues, Product, Promotions and bonus, Verification, VIP Topics, Withdrawal}` → `Form L2 - {…many…}` → `Form L3 - {WS Declined, WS Pending}`. Plus `Issues L2 - {Account, Deposits, Promotions, Sportbooks, Website, Withdrawal}`, `Level 2/3 - …`.
- **Payments:** Deposit Amount, Payment Date, Payment Gateway, PSP, Transaction ID, External ID (PSP ID), Player ID.
- **Domain:** Bonus name/type, User Level, Type of contact, Type of Issue, Approval status, Topic.
- **Resolution:** Resolution tier, Resolution type, Required tasks, Channel group.

**→ Specs:**
- These become our **custom attributes** (0021) — model the field list + drop-down option sets (capture option values next).
- **The L1/L2/L3 form hierarchy is a ready-made category/sub-category taxonomy** → seeds analytics (0027). Strong argument for a **hybrid taxonomy**: use their L1 (and L2) as the fixed top levels, LLM refines/auto-classifies within them.

## Tags → labels + analytics dimensions

Hundreds of tags, clear prefixed families (top by volume): `auto_confirmation` (179K), `regular` (163K), `auto_ended_chat` (70K), `bot_managed` (48K), `deposit*`/`cat_deposits`/`l1_deposit_*`, `withdrawal`/`cat_withdrawal`, `verification`, `promotions`/`cashback_bonus`/`free_spins_bonus`, `vip*`, `self_exclude`, `fraud_accusation`, channel/routing tags (`auto-routing`, `by_provider1`).

**→ Specs:** migrate the tag set as **labels** (0021); the `cat_*` / `l1_*` / `toc_*` prefixes are effectively existing analytics dimensions — reuse them.

## Macros

**98 active macros**, chat-oriented, bilingual. Families: greetings ("Chat - Bienvenida …"), closings ("Chat - Cierre …"), KYC ("Change personal details with/without KYC"), **account-safety** (self-exclusion / harm-related closures), country/currency, follow-ups. Usage counts present (some 2000+/7 days).

**→ Specs:** these are the "practical macros" (0021). Migrate the high-usage ones first; each is reply-text + actions.

## Triggers & automations

**Custom triggers (8):** Route to Deposits by keyword; Assign new tickets → Support group; Ghost Contact → add `no_csat`; Request CSAT (messaging); CSAT request for email; auto-routing tag; Automatic reassignment of reopened tickets; Automatic reassignment via closed ticket. **Automation:** Auto-Ended Chat TAG (auto capacity release).

**→ Specs:** our automation engine (0021) must cover: keyword routing, default-group assignment, CSAT dispatch (messaging + email), tag-on-event, reassignment on reopen/close.

## Groups & roles → teams + RBAC

**8 groups:** Support (default, 58), Deposit requests (43), VIP (8), VIP Account Managers (2, "Level 1 escalation"), General Level 1 Support, Deposits, Directa24 Team, PayCord Team. **Roles:** Agent / Admin (Zendesk Support roles). Note (operator): **"super admins must be able to add/remove access."**

**→ Specs:** teams (0006) = the group list. RBAC (0004): at minimum Agent / Admin / Super-admin, plus **group/queue-scoped access** (Deposits vs VIP vs General) and escalation tiers (L1 → VIP Account Managers). Capture custom-role permission details next if any exist.

## Routing / auto-assignment

Omnichannel routing, **Round-robin** assignment; skills-based OFF; **reassign reopened tickets when agent Offline** (email + messaging); messaging **auto-accept**; **count inactive conversations toward capacity**; SLA-prioritization OFF.

**→ Specs (0021 auto-assign):** round-robin within group + capacity limits + reopen-reassignment. "As in Zendesk" is now concrete.

## Views

~20 views: by state (New/Open/Pending/Unsolved/Closed), **Deposit - In progress (3K)**, VIP General, Supervisor Review, **Bot Managed (2.3K)**, **Agent Escalated (3.5K)**, VIP Support, Account Management, Auto-Ended Chats – To review.

**→ Specs:** our saved views/filters set. Note the supervisor-review and bot-escalation workflows.

## SLA

**One policy: "Set first reply time."** SLA prioritization in routing is off.

**→ Decision update:** SLA (was "optional later", 0012) → **build a basic first-reply-time SLA** — they actively use it. Keep it simple (first-reply target), expand later.

## Data migration

**UI full export is unavailable** (no Account → Tools/Reports section — plan/permission limit, per operator's page 35 note).

**→ Decision update (0026 migration):** migrate via the **Zendesk REST API** (`/api/v2/`: tickets, users, organizations, ticket_fields, macros, triggers, automations, views, groups, sla_policies). Next step: I write the concrete API pull commands for the operator's subdomain + token. Volume is large (372K tickets) → plan a paginated/batched export.

## What to capture next (to finish specs)
- Drop-down **option values** for the key custom fields (Form L1/L2/L3 lists) — for the taxonomy.
- Any **custom roles** permission detail (if on an Enterprise plan).
- Forms (p24–27), user/org fields (p34), remaining macros (p8–10) — nice-to-have.
