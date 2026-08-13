# chats

Core conversations / ticketing service. **State:** a **gRPC microservice** over its **own** Postgres
exposing `HealthService.Check`, the **chats-core domain** (feature 012, roadmap 4.1–4.3 —
conversations, messages incl. protected private notes, player feed) and the **workflow layer**
(feature 013, roadmap 4.4–4.5 — assignment + round-robin, labels, macros, canned responses), plus the
**automations engine + first-reply SLA** (feature 014, roadmap 4.6–4.7). Audit log / uploads / exports
(4.8–4.10) and VIP routing (4.11–4.14) are later features.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50053**): `HealthService.Check`, `ChatsReadService`,
  `ChatsWriteService`. Feature-013 additions are **additive** RPCs on the same two services
  (assignment/auto-assign, label attach/detach/create/list, macro define/list/apply, canned
  create/list) — no existing field was renumbered.
- Owns `chats_db` via role `chats_user` — no cross-service DB access (Principle VIII).
- Tenant data is read/written ONLY via `PrismaService.forAccount(accountId)` (account-scoped,
  fail-closed — feature 007 / Principle I). `brand_id`/`player_id`/`assignee_operator_id`/`author_id`
  and message `mentions[]` are **soft refs** — resolved via gRPC, never joined.
- **RBAC at two tiers:** the gateway `@RequiresPermission` guard **and** this service's
  `ChatsAccessGuard` (reads `x-actor-permissions` from gRPC metadata) both enforce, deny-by-default
  (Principle II / SC-004). Keys reused from the RBAC catalogue: `crm.inbox.view` (reads),
  `crm.conversation.reply` (message posts + status). **Feature 013 adds three keys:**
  `crm.conversation.assign` (assign / reassign / unassign / auto-assign), `crm.labels.manage`
  (create labels + attach/detach), `crm.templates.manage` (**author** macros + canned responses).
  Existing `crm.macros.use` gates **applying** a macro — authoring and using are deliberately
  different capabilities. **Feature 014 adds two more:** `crm.automations.manage` (author rules, read
  run records) and `crm.sla.manage` (the first-reply target). Both are supervisory — no operational
  agent role holds them by default, because whoever can author rules decides what the system does by
  itself.
- **Caller context rides in gRPC metadata** (`x-actor-account-id` / `-user-id` / `-role` /
  `-permissions`), never in message fields (research R1).
  *⚠️ **This paragraph described a brand-scope header until feature 022 corrected it.** It read "brand
  scope (`x-actor-brands`) intersects list/feed results; singleton reads/writes are brand
  resource-checked" — machinery **ADR 0038 removed**, because there is one support department serving
  every brand and a brand therefore never decides who may see what. Brand is a player's **identity** and
  a **filter a caller may ask for**; it is never a permission. The code has been clean since feature 020
  and a standing guard (`tests/data-model/no-brand-scope-remnants.spec.ts`) keeps it that way — but that
  guard scans `.ts` / `.proto` / `.prisma`, not Markdown, so this file went on describing a control that
  no longer exists. A doc that promises an authorization check is exactly as misleading as inert code
  that looks like one.*
- **SEC-13 (private notes):** the CUSTOMER thread projection excludes private-note rows **at the
  query** (`private:false`) — they are never loaded or serialised for a customer view (SC-002).
- **Macro apply is all-or-nothing (FR-008).** Two layers, in this order: every check (each action's
  own permission, conversation access, label existence) runs **before** any write, and the writes
  themselves run in one `$transaction`. So a refused macro leaves **zero** changes rather than a
  rolled-back attempt — and bundling actions can never bypass a permission the caller lacks.
- **Round-robin is a pure module** fed a caller-supplied candidate set (`selectRoundRobin`), with the
  rotation cursor persisted per `(account_id, group_key)`. Live team membership + operator capacity
  come from the Users service in **Phase 5** (roadmap 5.3); until then a request without candidates
  answers `GROUP_ROUTING_NOT_AVAILABLE` instead of guessing a group. The cursor read-modify-write and
  the assignment share one transaction, so two concurrent callers cannot be handed the same operator.

- **Automations (4.6).** A rule = trigger + conditions → ordered actions, sharing the **same action
  vocabulary as macros** so "what a bundle may do" and "what a rule may do" cannot drift apart. Three
  properties are load-bearing:
  - **A rule acts with its AUTHOR's CURRENT permissions**, re-resolved from auth on **every**
    evaluation (FR-023; the operator chose this over a snapshot). Revoking a permission through Access
    Management therefore also stops that person's rules — no separate disable step, no frozen
    privilege. There is deliberately **no cross-request cache**, so there is no stale window and
    nothing to invalidate; the engine memoises only within one evaluation pass. Accepted cost: a rule
    goes quiet when its author changes role, which is why every refusal is recorded with the missing
    key.
  - **All-or-nothing, by ordering rather than rollback.** Definition re-validation, condition matching,
    the author's permission per action, and referenced-entity existence all happen **before** the first
    write. A refused rule leaves the conversation completely untouched.
  - **No cascade, structurally.** Domain events are published **only from gRPC controllers**; the
    engine writes through repositories, and repositories cannot publish. So an automation's own writes
    emit nothing and no rule configuration can loop — a `suppressEvents` flag would have been one
    forgotten argument away from an unbounded write loop. Policed by
    [`src/events/no-publish-from-repositories.spec.ts`](src/events/no-publish-from-repositories.spec.ts).
  - **At most once per (rule, conversation, event)** — enforced by a unique index on
    `AutomationRun(automation_id, conversation_id, event_key)`, not by an application check (a
    check-then-write is a race; an index is not). The run record shares the transaction with the
    actions, so a duplicate aborts the whole batch.
- **First-reply SLA (4.7).** A per-account target (with optional per-priority / per-brand overrides)
  and one clock row per conversation. Starts on the first inbound player message; stops **only** on the
  first **public** staff reply — a private note is inert (FR-012, the SEC-13 distinction on a new
  surface). A status change, including `resolved`, neither stops nor pauses it. The target is **frozen
  onto the row at start**, so editing the policy cannot retro-breach anything. **No policy ⇒ no
  clock** — absence of a target is not a zero target.
- **The breach is detected by a timer, not by a reader.** The worker fires a repeatable BullMQ tick
  (default 30 s) into `ChatsMaintenanceService.SweepFirstReplySla`; detection latency is bounded by that
  interval by design. A breach emits an event exactly once (`breach_announced_at` + a timestamp-free
  `breach:<id>` key), which rules can trigger on — but the measurement never depends on any rule
  existing.
- ⚠️ **The one unscoped tenant read in this service** lives in
  [`src/sla/sla-sweep.repository.ts`](src/sla/sla-sweep.repository.ts) — read its header before
  touching it. A timer has no caller and therefore no account context, so answering "which accounts
  have overdue clocks" cannot go through `forAccount`. It is fenced five ways: **ids only**, **counts
  only leave the service**, **system-actor only**, **no gateway route**, **batch-capped** — and every
  write that follows is scoped normally. Logged in the feature's plan under Complexity Tracking.

## Interfaces
- gRPC contracts: [`chats.proto`](../../libs/proto/crm/chats/v1/chats.proto) (own) +
  [`health.proto`](../../libs/proto/crm/health/v1/health.proto). Consumes
  [`users.proto`](../../libs/proto/crm/users/v1/users.proto) /
  [`brands.proto`](../../libs/proto/crm/brands/v1/brands.proto) once those read servers land (Phase 5).
- DB schema (its own): [`prisma/schema.prisma`](prisma/schema.prisma) → `chats_db`. Migrations in
  [`prisma/migrations/`](prisma/migrations) (Track B: `prisma migrate deploy`). Feature 013 adds two
  account-scoped tables — `CannedResponse` and `RoundRobinState` (rotation cursor). Feature 014 gives
  the reserved `Automation` model meaning (+ author, position, revision) and adds `AutomationRun`,
  `FirstReplySlaPolicy` and `ConversationSlaState`. Feature 016 adds `MessageAttachment`. Feature 022 adds
  **two maintained columns on `Conversation`** — `last_inbound_at` / `last_outbound_at` — and no table.
  Feature 023 adds `ConversationTransition` plus **two more columns on `Conversation`** (`subject`,
  `subject_source`) and one index on the derivation WINDOW. Feature 031 adds **two more columns and no
  table** — `backlog_at` (the queue) and `priority_rank` (the urgency order) — each with its own index. All are enrolled in
  [`src/prisma.scoped-models.ts`](src/prisma.scoped-models.ts), cross-checked against the schema by
  `tests/data-model/account-scope-coverage.spec.ts`.
- Isolation extension: [`libs/common/src/account-scope.ts`](../../libs/common/src/account-scope.ts).

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`, **`AUTH_GRPC_TARGET`**, **`USERS_GRPC_TARGET`**, and — new in 023 —
**`TRANSITION_RETENTION_DAYS`**, **`TRANSITION_RESTRICTED_RETENTION_DAYS`**,
**`SUBJECT_WINDOW_TIMEOUT_MINUTES`**, **`ROUTING_DEFAULT_CAPACITY`** and — new in 031 — the optional
**`ROUTING_CAPACITY_BY_BRAND`** (`brand-a:4,brand-b:2`; an unparseable entry is ignored, never fatal, and the
default stays the fallback). Validated at boot by [`src/config.ts`](src/config.ts).

⚠️ **`loadConfig` treats every key in the shape as required, whatever its zod schema says** — the presence
check runs before validation, so a `.default()` never applies. Feature 023's first draft carried defaults
for all four of its keys and the container crash-looped on its first live boot. A new key is therefore
always a **two-file change**: `src/config.ts` and the matching `environment:` entry in `compose.yaml`
(compose substitutes `${VAR}` from `.env`; it does not inject it).

**Cross-service dependency (new in 014):** chats → **auth** (`ResolveEffectivePermissions`) to resolve a
rule author's live permissions. Acyclic — auth never calls chats. Without the dial target every rule
would refuse (fail-closed), which is safe but useless, so it is a boot requirement.

**Cross-service dependency (new in 016):** chats → **users** (`ClaimUploads` / `DescribeUploads`) for
message attachments. Acyclic — users never calls chats. Because the config guard is refuse-to-start,
adding a cross-service client to chats is always a **two-file change**: this key and the matching entry
in `compose.yaml`. Omitting either is a boot failure rather than a runtime surprise, which is the point.

**Cross-service dependency (new in 030, roadmap 4.14):** chats → **users**
(`ListAssignedPlayers`, on the existing `ChatsPersonModule` channel) to resolve **the caller's own
portfolio** before a conversation read. Acyclic; no new configuration — `USERS_GRPC_TARGET` has been a
boot requirement since 016.

⚠️ **It is on a hot read path.** Every list or detail read by an account manager costs one extra gRPC
round trip, and it is **not cached on purpose**: a cached scope outlives the fact it describes, and the
symptom — an AM still seeing a player who is no longer theirs — is a data-access defect that looks like a
stale UI. The gateway's 30-second RBAC cache produced exactly that class of false defect report at
feature 017, one layer up. Measure before adding one.

⚠️ **Fail closed.** If the portfolio cannot be established the read **fails**; it never falls back to an
unnarrowed list, because an unavailable `users` and *"attached to nobody"* are indistinguishable unless
one of them is an error — and the wrong one of those hands over every VIP conversation in the account. The
downstream status is preserved, so *"you may not ask this"* stays separable from *"the source is down"*.

ⓘ `amAuthUserId` is sent **empty**, which the users contract defines as *"the calling manager's own
portfolio"*. Naming somebody else requires `users.list.view`; we never name anyone, so nothing is
laundered and no extra permission is needed. Who is narrowed comes from `conversation/portfolio-scope.ts`,
which imports 026's `visibleTiersFor` rather than deciding again.

## Run / test
```bash
npm run test --workspace services/chats   # Track A (mocked Prisma; no Docker)
npm run seed:chats                         # synthetic seed (Track B, live chats_db)
```
Runs as part of `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Gotchas
- **The REST edge maps enums fail-closed** ([`gateway/src/chats/wire.ts`](../gateway/src/chats/wire.ts)):
  an **unknown** `kind`/`status`/`projection` is a **400**, never a silently-chosen default. Track B
  caught the original mapper coercing any unrecognized `kind` to a **public reply**, so a client
  posting `{"kind":"private_note"}` published an intended internal note **to the customer** — the
  SEC-13 failure mode via an ordinary typo. Only `''`/absent takes the documented default.
- **gRPC errors are translated at the gateway** ([`gateway/src/chats/rpc.ts`](../gateway/src/chats/rpc.ts)):
  `NOT_FOUND → 404`, `PERMISSION_DENIED → 403`, `INVALID_ARGUMENT → 400`, else generic 500 — no
  downstream detail in the body (SC-007). Before this, a cross-account read (correctly `NOT_FOUND`
  here) surfaced as a raw **500** with a stack trace.
- Does **not** connect to Postgres at boot — a downed DB degrades health, doesn't crash startup.
- Keyset pagination only (no offset/COUNT) — `page_size` capped at 100 (default 50). Cursor util:
  [`src/shared/cursor.ts`](src/shared/cursor.ts).
- @mention capture is **write-only** in this feature; existence/notification resolution is deferred
  to the Users read endpoint (Phase 5) — resolution is account-scoped, so an out-of-account id can
  never resolve (research R6). **The assignee operator id is deferred the same way** (013 research
  R8): stored as an account-scoped soft ref, validated when the Users read path ships. Do not add a
  Users gRPC call to the assignment path.
- A stored macro `definition` is **re-validated on read and on apply**, not trusted: a blob written
  by an older, looser version must not silently perform something this version does not understand.
  An unreadable definition surfaces as an empty action list on list, and refuses on apply.
- A stored automation `definition` is re-validated the same way, at author time **and** at run time.
- **`$transaction` is used in its BATCH form**, never the interactive callback, on every 014 path. That
  is deliberate: 013's live-only defect was pulling `$transaction` into a variable and losing its
  `this`, after which Prisma died on `_engineConfig`. No 014 path needs a read-modify-write inside the
  transaction, so the form that cannot have that bug is the one used.
- **`AutomationRun` grows without bound** — this feature ships the table and its indexes, not a
  retention policy (deferred by ADR 0015; a trim job belongs with the worker catalogue, 7.3). The row is
  deliberately narrow (ids, an outcome, a short reason) so it stays cheap until then.
- The `'*'` sentinel on `FirstReplySlaPolicy.scope_*` is not cosmetic: Postgres unique indexes treat
  NULLs as **distinct**, so NULL scoping would allow two account-level defaults and make "the target"
  ambiguous. `'*'` is refused as a literal priority/brand value everywhere.
- tsx/esbuild emits no decorator metadata → every constructor param uses explicit `@Inject`.

## Audit trail (feature 015, roadmap 4.8)

This service is one **source** of the product's single audit trail (ADR 0019; SEC-29/SEC-30; extended by
0032/SEC-AP3). The trail is one logical log physically living in three databases — an entry must be written
inside the transaction of the action it describes (spec Q3: action and entry succeed together), and a
cross-service database write is forbidden (Principle VIII). So the **table is duplicated** and the vocabulary
is shared from [`libs/common/src/audit`](../../libs/common/src/audit);
`tests/data-model/audit-entry-identity.spec.ts` asserts the three definitions never drift apart.

- **Append-only, structurally.** No repository method and no controller updates or deletes an entry, for any
  role including the owner. Audit integrity is not a permission anyone can hold — the guarantee is the
  ABSENCE of the path, and `tests/audit/append-only.spec.ts` asserts that absence across every service and
  the gateway.
- **Strict, not best-effort.** Every v1 class refuses its action if the entry cannot be written. Before this
  feature the privilege trail was best-effort **by accident** (written after the mutation, outside any
  transaction), so `tests/audit/no-best-effort.spec.ts` guards the decision structurally.
- **PII-free by construction.** `detail_json` is validated against a per-action-class key allow-list; a
  contact value or a message body is not expressible. `target_ref` identifies, never copies.
- **Read** via `ListAuditEntries`, gated by `platform.audit.view` at this tier and at the gateway. The
  gateway fans out to all three sources and merges them into one ordered log
  (`services/gateway/src/audit`). There is **no** write/update/delete RPC anywhere.
- **Growth** is unbounded until retention exists (ADR 0015 defers it; a trim job belongs with the worker
  catalogue 7.3 — and must itself be audited as `audit.trim`, or the one operation able to destroy history
  would be the one with no record).

**Writer in this service:** `automation.delete` — removing a rule that acts by itself is a sensitive act, so
the delete and its entry commit in one transaction. The rule is **read first**: `deleteMany` reports a count of
0 for an absent id while the transaction still commits, so a blind delete-and-record would file an entry for a
deletion that never happened. A trail that records non-events is worse than one with a gap — a reader cannot
tell them apart.

## Attachments (feature 016, roadmap 4.9)

Chats holds a **soft `upload_id`** and nothing else. The bytes, the validation and the object-store
credentials all live in `users` — the second consumer of the upload path is the profile avatar (8.10),
which has nothing to do with conversations, so owning uploads here would make every avatar read a chats
call (research R1).

- **`MessageAttachment`** (`chats_db`): `account_id` + `message_id` (FK, cascade) + a soft `upload_id`
  reference across the database boundary, plus `position` for stable display order. The
  `@@unique([message_id, upload_id])` IS the "attached twice" guarantee — a check-then-write would be a
  race; a unique index is not (the 014 discipline).
- **Claim BEFORE the write** ([`src/message/message.grpc.controller.ts`](src/message/message.grpc.controller.ts)).
  Everything that can refuse — conversation access, id shape and cap, the cross-service describe and
  claim — runs before the first row is written, so a refused attachment leaves **no partial message**
  (FR-015, the 013 ordering discipline). Two databases and no distributed transaction means a failure
  direction had to be chosen: claiming first fails toward wasted bytes, claiming last fails toward a
  *referenced* upload a future reclaim job would delete. Wasted storage beats data loss.
- **Message and attachment rows are written in ONE batch `$transaction`.** The message id is generated up
  front so the two statements are independent — which is what makes the batch form (the one that cannot
  reproduce 013's lost-`this` defect) usable here at all.
- **The private-note guarantee is inherited, not re-implemented.** Attachments are selected *through* the
  message as a nested select, and the customer projection already excludes private rows AT THE QUERY
  (feature 012). So a private note's attachments are never loaded — and `private-note-attachments.spec.ts`
  asserts the outcome including that attachment and upload **ids** are absent, not merely the bytes: the
  012 lesson was that the id and the mentions leaked alongside the body (SEC-13 / SC-008).
- **One `DescribeUploads` per thread page**, never one per message (Principle VII, no N+1). Metadata is
  fetched and deliberately **not** denormalized into `chats_db` — that keeps the PII-capable
  `display_name` in exactly one database.
- **Read vs write degrade differently, on purpose.** A failure to describe on the WRITE path refuses the
  message (the agent believes a file was sent). The same failure on the READ path degrades to no
  attachment metadata — a missing thumbnail is not worth a blank conversation.

## Exports (feature 017, roadmap 4.10)

Chats **owns** the export record, the producer and the `export.create` audit entry. It does not own the
artefact: the bytes go to `users` through the existing `CreateUpload`, so the feature-016 single-path
guarantee holds unchanged.

- **`ExportJob`** (`chats_db`, see [`prisma/schema.prisma`](prisma/schema.prisma)) — request, status,
  filters, `expires_at`, and the soft `upload_id` once an artefact exists. Enrolled in `SCOPED_MODELS`, so
  every tenant-facing read goes through `forAccount`.
- **Code:** [`src/export/`](src/export) — `export.service.ts` (accept / produce / record),
  `export.producer.ts` (pages the *conversation read path*, never its own query),
  `export.repository.ts`, `export.quota.ts`, `export.maintenance.ts` (the two sweeps),
  `error-label.ts`, `export.grpc.controller.ts`.
- **The scope catalogue is data** — [`libs/common/src/exports/scopes.ts`](../../libs/common/src/exports/scopes.ts).
  Permission, row limit, byte cap, TTL, quota: all on the row. Adding an exportable thing is adding a row.
- **The producer acts with RE-RESOLVED authority.** Request and production are different processes at
  different times, so the requester's *current* permissions are resolved through the auth client at
  production time. A permission revoked in between yields `failed` / `authority_revoked`, not a file.
  Caching them on the row would reintroduce 014's stale-authority window.
- **Completion is ONE transaction** — `ready` + the audit entry, or neither (FR-020). An unwritable entry
  fails the export as `record_failed`, which is its own code rather than a borrowed one: the artefact was
  produced and stored, then deliberately abandoned, and sending an operator to the database for a problem
  in the trail is the one diagnosis in this feature that must not be guesswork.
- **⚠️ Filters are translated by the LIST's own converters** (`../shared/wire.ts`,
  `../../gateway/src/chats/wire.ts`). Track B found the export validating the human vocabulary and
  forwarding the string unchanged into a proto **enum** field — grpc-js coerced it to UNSPECIFIED and the
  export produced an empty file reporting success. Validating a vocabulary is not translating it. The same
  run found `slaOutcome` accepted and then dropped, which produced *every* conversation.
- **The two sweeps are system-actor only, batch-capped, counts-only, and have no gateway route.**
  `RunDueExports` claims `queued → running` conditionally (two ticks, one winner, no bookkeeping) and
  fails a stale claim as `interrupted` rather than retrying — which is what makes "an interrupted producer
  leaves no downloadable partial" provable. `ExpireDueExports` flips `ready → expired` and clears
  `upload_id`; **the bytes are deleted independently by `users`**, from the same TTL constant, so neither
  service waits on the other.

## Contact history & last contact (feature 022, roadmap 4.13)

The player card asks two questions this service now answers: **when did we last talk to this customer**,
and **which channels do they use**. Both across one brand's record (`GetPlayerContactSummary`) and across
every record explicitly linked into one human (`GetPersonContactSummary`, `GetPersonFeed`).

- **⚠️ `Conversation.updated_at` is NOT the last contact, and that is why this exists.** It is a Prisma
  `@updatedAt` column: relabelling, reassigning or resolving bumps it. A card built on it reports our own
  internal work as customer contact and looks entirely right doing so. The facts come from **messages**,
  maintained on two nullable columns.
- **The stamp is written inside `MessageRepository.post`'s own transaction**, from the created row's own
  `created_at`, for the column [`message/contact-stamp.ts`](src/message/contact-stamp.ts) selects. That
  differs deliberately from the neighbouring SLA write, which happens *after* the transaction: the sweep
  re-derives an SLA state from Postgres, and nothing re-derives a contact stamp — so a crash between two
  separate writes would leave a message the card cannot see.
- **A private note and a system entry stamp nothing.** "A private note is inert" is the SAME rule the
  first-reply clock encodes (roadmap 4.7); one fact, one definition, or the product ends up holding two
  answers to "did we reply".
- **The rule exists in two languages by necessity** — TypeScript for new messages, SQL in the migration's
  backfill for the existing history — and `tests/migration-022.spec.ts` compares them textually, so
  changing one without the other fails a test instead of corrupting data.
- **One grouped query answers everything**: `groupBy(['channel','status'])` with `_count` and `_max` over
  the two columns. No `Message` row is read on a summary path, so the cost is bounded by the customer's
  conversation count and not by their message history. The channel rollup, the per-status counts and the
  totals are arithmetic on that ONE result set, which is what makes "the per-channel counts sum to the
  total" an identity rather than an agreement between two queries.
- **The unrecorded channel is a boolean, not a name.** `Conversation.channel` is nullable until Phase 6,
  and `''` already renders a null channel elsewhere — so a sentinel like `"unknown"` would collide with a
  future channel of that name. `ChannelContactEntry.channel_unrecorded` cannot collide with anything.
- **Per-status counts, never a single "open count"** — *open* is ambiguous between `status = open` and *not
  resolved*, and `pending` / `snoozed` make the two readings differ on real rows.

### The person level, and the two keys

`GetPersonFeed` was **declared by feature 020 and served by nothing** for a whole roadmap point, while
`users.ListPersonMembers` sat on the other side with no caller. Both halves are built now:

- membership is resolved through [`person/person-members.client.ts`](src/person/person-members.client.ts),
  which forwards **the caller's own metadata** so `users` enforces **`crm.contact.view`** itself — knowing
  that two records are one person is a statement about a customer. A system-actor call would launder that
  key, so it is not made. Conversations themselves stay behind `crm.inbox.view`;
- if membership cannot be established the read **fails** (`MembershipUnavailableError`). It never answers
  from the members that happened to resolve: an aggregate over a subset of a human is indistinguishable
  from one over the human, so nobody would investigate it;
- the union is **one** indexed query with an `OR` over the member pairs — all conversations live in this
  database, so the k-way merge the audit log needs (three databases) does not apply;
- an **empty** membership is a data state (never-contacted); an **unreadable** one is a failure. Answering
  both the same way is the thing that requirement forbids.

**Standing guard added with it:** [`tests/contracts/every-rpc-is-served.spec.ts`](../../tests/contracts/every-rpc-is-served.spec.ts)
fails when any service declares an rpc nothing serves, unless the declaration itself carries
`option deprecated = true` or an `UNSERVED:` note — and it fails again if a marked rpc gains a handler.
Written repo-wide because running the check by hand found **two more** instances beyond this one.

---

## The transition stream, and what it is NOT (feature 023, roadmap 4.8a)

`ConversationTransition` is **durable history**: one append-only row per thing that changed, carrying the
reporting dimensions **as they were at that instant**. Every metric the support team lives by — backlog,
reopened %, one-touch %, first reply time, per-agent load — is derived from transitions, not from a
conversation's current row. Store only current state and the past becomes permanently unanswerable: no
later migration can invent a transition that was never recorded.

⚠️ **THREE THINGS WITH SIMILAR NAMES. DO NOT MERGE THEM.**

| | What it records | Failure semantics | May carry customer text? |
|---|---|---|---|
| `AuditEntry` (015) | **sensitive actions** | **STRICT** — a failed write refuses the action | no, structurally inexpressible |
| `DomainEvent` (014, `src/events/`) | in-process **automation trigger** | deliberately lossy, synchronous | **yes**, in memory only |
| `ConversationTransition` (023) | **durable history** | recording **atomic**, delivery best-effort | no — ids and enums only |

Merging the third with the second would land message bodies in an append-only store. The word *event* is
avoided throughout this feature for that reason, and
[`tests/transitions/no-dispatcher-crossover.spec.ts`](../../tests/transitions/no-dispatcher-crossover.spec.ts)
fails the build if the two ever touch.

**"Best-effort" is a property of a HOP, not of a write.** ADR 0046 originally asserted both *written in the
same transaction* and *best-effort*, which cannot both hold. Split in §4a: **recording is atomic** (a
rolled-back change leaves no record), **delivery to a consumer is best-effort** — and there is no consumer
yet, so nothing is delivered at all.

### Writing one

The catalogue ([`libs/common/src/transitions/catalogue.ts`](../../libs/common/src/transitions/catalogue.ts))
is **closed and additive**; the payload allow-list
([`payload.ts`](../../libs/common/src/transitions/payload.ts)) makes a message body, a contact value, a file
name and **the subject text** inexpressible rather than merely discouraged.

`TransitionRecorder` has **two entry points, and which one you need depends on the transaction style**:

- `record(tx, input)` — inside an **interactive** `$transaction(async (tx) => …)`;
- `buildStatement(db, input)` — returns an **unexecuted** statement to append to a **batch**
  `$transaction([…])`, whose atomicity is *by ordering* (every check precedes the batch). That form is
  proven live 68/68 by feature 013 and was deliberately not rewritten for the sake of a uniform call style.

⚠️ **Five code paths write `status` / `assignee_operator_id`, and all five must record.** The task list said
two; reading the code by hand found four; the guard
([`src/transition/sanctioned-writers.spec.ts`](src/transition/sanctioned-writers.spec.ts)) found **five** —
the fifth being `assignment/round-robin-state.repository.ts` (auto-assignment), which writes the column
directly and is invisible to a search by method name. A partial stream *looks complete and answers
wrongly*. Adding a writer without recording fails the build.

**The one read** is `ReportTransitionStreamHealth` — counts and one timestamp, system-actor only, no
gateway route. It exists because the aggregation store (roadmap 11.0) does not: without it nothing in the
product could notice the stream had stopped being written, which is machinery this codebase has shipped
twice (015, 017).

**Retention is configuration and NOTHING DELETES.** The windows are 🅿 provisional, revised by the
operator's answer on access-record retention (Q1) and by SEC-25.

---

## The conversation title (feature 023, roadmap 4.18)

Their Zendesk fills a chat's subject from the first message, literally, so lists read as *«привет»*,
*«???»* and mid-word fragments. Here the title is derived from the customer's first **substantive** words
and then **frozen**.

- **substantive** = at least 15 characters **and** at least 2 distinct words **and** not in the filler
  vocabulary ([`src/subject/filler.data.ts`](src/subject/filler.data.ts) — data, not code, so the support
  team can extend it without a deploy). Matched as a **union across all languages**: this product has no
  language signal, and a Spanish greeting filtered in a Russian conversation is harmless. That also makes
  "produce it in the customer's language" free — the title is their own words, copied, so there is no
  generation step and nothing to translate;
- the **window** closes at whichever comes first: the customer's **3rd** message · the **first public staff
  reply** · **`SUBJECT_WINDOW_TIMEOUT_MINUTES`** (closed by a sweep, not by a delayed job per
  conversation — a lost delayed job is a window never closed, silently);
- then `subject_source = 'auto'` and **no automated writer touches it again**. A human write sets
  `manual`, which is permanent — and the lock is against **automation**, not against people: a person may
  rename what another person named;
- **the fallback stores the topic when known and NULL when not — never the `—` glyph.** The dash is a
  *rendering* rule (ADR 0044), and storing it would put a display decision in the database and make it
  sortable as if it were content. `subject_source = 'auto'` with a null subject already says "we looked and
  the customer never said anything usable", which a bare null could not;
- **search must never depend on it** (U19). It is model-generated and human-editable, so navigation built
  on it is navigation built on a mutable, occasionally wrong string — asserted structurally by
  [`src/conversation/subject-independent-search.spec.ts`](src/conversation/subject-independent-search.spec.ts).

⚠️ **`subject_set_by` / `subject_set_at` are deliberately NOT columns.** Who named the conversation and when
are answered by the `conversation.subject_set` transition, whose payload is `{ source }` and **never the
title** — a title is the customer's or an agent's own words, and an append-only store is the last place for
them. This was first drafted as an *audit* action, and the difficulty of finding an honest class for it
among privilege / deletion / access / export / assignment / retention **was the answer**: ADR 0019 records
sensitive actions, and a title edit exposes nothing, deletes nothing and changes no privilege.

---

## The two group bindings (feature 024, roadmap 5.3 — [ADR 0039](../../cowork/decisions/0039-groups-are-an-access-input.md))

The group ENTITY lives in `auth` (see that service's README for why). Chats owns two of its bindings and
holds the group id as an **opaque soft ref**, never joined.

**Routing — `AutoAssignConversation` may name a group.** This is the source feature 013 left a placeholder
for: its handler answered `GROUP_ROUTING_NOT_AVAILABLE` and said "until the Users service can resolve teams
and capacity (roadmap 5.3)". `assignment/group-pool.ts` now assembles the pool from three places —
membership from **auth**, active operator profiles from **users**, current load counted **here**, because
chats owns the conversations and it is the one input nobody else can compute. Capacity comes from
`ROUTING_DEFAULT_CAPACITY`, 🅿 **PROVISIONAL** and revised by roadmap 4.19–4.21 (per-channel budgets) and
5.9 (presence).

- `group_id` **wins** over a caller-supplied `candidates` list; they are never merged. Two sources for one
  routing answer is how a routing decision becomes unexplainable.
- The caller-supplied path is **unchanged**, and so are both honest non-answers.
- ⚠️ **An empty pool and a failed lookup are different things.** Both clients raise rather than returning an
  empty list, so an unreachable auth or users can never be reported as "this desk has nobody" — which would
  stop routing for a whole team while every request still answered 200.
- The chosen desk is recorded on `Conversation.routed_group_id`, in the **same write** as the assignee.

**Automations — a rule may be scoped to a group** (`Automation.scope_group_id`). It is checked before the
conditions, because a scope narrows what a rule is *about* rather than being something its author reasons
over. ⚠️ **A rule whose group no longer exists matches NOTHING**, and does so by construction: there is no
"does this group still exist?" lookup, because a deleted group is never again the routed group of anything.
The dangerous alternative — a scoped rule silently becoming an everything rule — is unreachable, not merely
avoided.

⚠️ **`Conversation.assignee_operator_id` is a `users.Operator.id` while group membership is an auth user
id**, so the pool performs an explicit translation. Nothing validates that column today and every other
actor reference in this service is an auth user id — recorded as a candidate repair point on roadmap 5.3
rather than reinterpreted here.

## The Inbox's filter and its orders (feature 029, roadmap 9.2; third order added by 031)

`ListConversations` gained a **`channel` filter** and an **`order`** — the only list in this service
with more than one order. Contract: [`libs/proto/crm/chats/v1/chats.proto`](../../libs/proto/crm/chats/v1/chats.proto).

⚠️⚠️ **`last_activity_at` on the wire IS `Conversation.updated_at`.** There is no `last_activity_at`
column and there never has been — the rename is recorded in
[`shared/wire.ts`](src/shared/wire.ts) and in `conversation-projection-covers-contract.spec.ts`. Both
orders therefore sort on `updated_at`, and the UI labels the column **"Updated"**: that value is a
Prisma `@updatedAt`, so relabelling, reassigning and resolving all bump it. A queue sorted by it and
called "last activity" reports our own bookkeeping as customer contact, and looks right doing so.

⇒ **Genuine customer contact is `last_inbound_at` / `last_outbound_at`** (feature 022). They stay
deliberately **unindexed** — projected and aggregated, never ordered or filtered on.

⭐ **There are THREE orders since feature 031** (`updated_desc`, `updated_asc`, `urgency_desc`). This
paragraph used to read *"there is no urgency / 'recommended' order, and the gateway refuses one with a
400 — nothing computes urgency"*. Something does now — see **The urgency rank** below. ⚠️ Still nothing
called **"recommended"**: the new order sorts by a stated key, and no code in this product makes a
recommendation.

### The cursor now carries its order

`OrderedCursor` (`[sortKey, id, order]`, [`src/shared/cursor.ts`](src/shared/cursor.ts)) is a
**second** primitive beside the plain `Cursor`, not a replacement:

- a keyset cursor names a row *in a sequence*; replayed under a different order it silently pages a
  **different** sequence — a plausible list with rows repeated and rows missing, and no error. The
  server refuses the mismatch instead.
- the two encodings are mutually unreadable (2- vs 3-element), so a conversation token is rejected by
  the feed and message endpoints, which is correct — they name rows in unrelated sequences.
- the six other read paths keep the plain cursor: every one has a single order keyed on `created_at`,
  and widening the shared type would have forced an `order` onto cursors that have no such concept.

⚠️ **`DEFAULT_CONVERSATION_ORDER` is `created_desc`, not the Inbox's default.** `list()` is shared by
both feeds and the CSV export, none of which asked for a new order — making `updated_desc` the
repository default silently re-ordered all three, and only the cursor's type change surfaced it. The
Inbox picks `updated_desc` at its own edge (`DEFAULT_INBOX_ORDER`).

### The channel filter

- `undefined`/`''` means **no filter**, never "conversations that have no channel". ~1 in 6 rows carry
  none and stay reachable only by not filtering.
- Validated for **shape, not membership**, at the gateway: a channel is *data, never a branch*
  (roadmap 9.6a), so a closed allow-list would make every Phase-6 channel unfilterable on arrival.
  Unlike a dropped filter, an unrecognised channel narrows to zero — visible — rather than widening.
- **Mirrored into `ExportFilters`.** An admin who narrows the Inbox to one channel and exports must
  not receive the whole set (SEC-AP2). The value crosses four hops (gateway parse → grpc controller →
  stored row → `filtersOf` at production); `slaOutcome` was once missing at the last one, and a
  dropped export filter *widens* the file.

Index: `@@index([account_id, updated_at])` — index-only migration, no column change (Principle VII).

---

## Push routing: capacity in UNITS, one backlog, and the drain (feature 031, roadmap 4.20 / 4.21 — ADR 0042)

**Capacity already existed** — `group-pool.ts` and `round-robin-state.repository.ts` counted a person's open
conversations against a fixed number. 4.21 changed its **shape**; it did not create it:

- **Units, not conversations.** [`src/assignment/capacity.ts`](src/assignment/capacity.ts) is arithmetic
  only (`costOfChannel`, `unitsUsed`, `hasRoomFor`), and a channel's cost may be **`'exclusive'`** — which
  is *not* a big number. 🅿 **Provisional operator defaults**: chat/messenger = 1 unit, budget 4; voice =
  exclusive. To be re-confirmed, not treated as decided.
- ⚠️ **An exclusive channel needs the agent HOLDING NOTHING**, not merely having room. "Four units free"
  and "holding nothing" are different facts and a voice call needs the second — hence `holdsNothing`
  alongside the number.
- **The budget is per brand** (`ROUTING_CAPACITY_BY_BRAND`, falling back to `ROUTING_DEFAULT_CAPACITY`).
  Per-role capacity is **not built**, and is recorded as blocked rather than forgotten.

**Routability is a property of the DESK, not of the person** (operator's decision, 2026-08-04).
`Group.routable` in *auth* answers *"is this desk a queue?"*, so the router never asks who anybody is.
⚠️ **It defaults to `false`**, so automatic distribution goes quiet until desks are marked — a deliberate,
loud, reversible silence in place of a quiet mis-route. `SetGroupRoutable` writes
`group.routability_changed` **even on a no-op**.

⛔ **An AM is never chosen by the machine.** `am-not-a-queue-agent-030.spec.ts` fails if any
routing/capacity/SLA module names a role that sees the `am_only` tier. This feature honours it by building
the pool from **queue roles** — there is no allow-list to be added to. Assignment **by a person** to an AM
stays allowed; what is forbidden is the machine choosing one.

**The backlog** ([`src/assignment/backlog.ts`](src/assignment/backlog.ts)) is one ordered sequence
(`backlog_at ASC, id ASC`) on the conversation row — no table.

- `enqueue` is **idempotent and the first instant wins**: a full desk produces retries, and an
  unconditional write would make every retry a demotion.
- The drain takes **the first item the freed capacity can SERVE**, not strictly the head. Strict FIFO
  starves everything behind work nobody can take, and reads as *"the queue is stuck"* rather than as a bug.
- ⚠️ **A skipped item keeps its place because NOTHING about it is rewritten.** That absence *is* the
  guarantee — rewriting `backlog_at` would send a conversation to the back for being briefly unservable.
- Capacity is **re-read for every item**, never once per batch: a batch snapshot hands the same freed unit
  to several conversations.
- `DrainBacklog` is a **worker-called maintenance rpc** (like the SLA sweep) answering **counts only**.
  High `skipped` with `assigned: 0` is the head-of-line condition — diagnosable without naming anybody.
- ⛔ **Nobody can pick from the queue.** There is no rpc and no route by which an agent takes a queued item;
  `no-backlog-take-path-031.spec.ts` asserts the *absence* rather than a refusal.

**Work that can reach nobody** becomes the audited event `conversation.unroutable`, carrying a reason
**class** (`desk_not_routable` / `nobody_available`) and no contact value. ⚠️ **An event and not a
notification, deliberately**: there is no alerting surface in this product (7.5 is the n8n ingest, 9.18 the
audit viewer), and an alarm with no consumer is the defect this repo already shipped once — the audit log
ran for five features with nothing reading it.

## The urgency rank (feature 031, roadmap 4.19)

`Conversation.priority_rank` (`Int`, default 0) plus the declared order `urgency_desc` =
`(priority_rank DESC, updated_at ASC, id ASC)`, indexed as
`@@index([account_id, priority_rank, updated_at])`.

⚠️ **What recomputes it: nothing periodic, by design.** The key is split by what moves each half.

| half | moves when | where it lives |
|---|---|---|
| the priority **word** | somebody changes it | stored as `priority_rank`, written by `priorityWrite()` |
| how long it has **waited** | by itself, with the clock | read at query time from `updated_at` |

⇒ **No stored value can go stale.** A rank that embedded age would need a sweep over the whole history to
stay true and would be wrong in between — invisibly, because a list in a plausible order looks like a list
in the right order.

⭐ **`priorityWrite()` is the only sanctioned writer of the priority column** and returns the word *and* the
rank together. `tests/data-model/priority-rank-recomputed-031.spec.ts` fails when any path writes
`priority:` by hand inside a `data:` object. Two paths write it: conversation create, and the
macro/automation action applier (`SET_PRIORITY`) — the second is the one a search for "the conversation
write path" misses.

⚠️ **Rank 0 is NOT `normal`.** Unset — and any word the product does not recognise, since the column is
free-form by design — sorts **below** everything set. Guessing `normal` would promote untriaged work above
work somebody deliberately marked `low`.

⚠️ **The keyset is GENERATED** ([`src/conversation/order-parts.ts`](src/conversation/order-parts.ts)):
`orderBy` and the cursor predicate both derive from one `ORDERS` declaration. This is the first order with
two columns, and a hand-written predicate for it is three clauses no review can check — while a predicate
that disagrees with the sort produces a plausible page two with rows repeated and rows missing. The token
format is **unchanged** for a single-column order (the bare ISO string), so nothing minted before 031 broke.
