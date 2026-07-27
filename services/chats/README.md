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
- **Caller context rides in gRPC metadata** (`x-actor-account-id/user-id/role/permissions/brands`),
  never in message fields (research R1). Brand scope (`x-actor-brands`) intersects list/feed results;
  singleton reads/writes are brand resource-checked. Absent brands ⇒ no brand filter (Brands service,
  Phase 5).
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
  `FirstReplySlaPolicy` and `ConversationSlaState`. Feature 016 adds `MessageAttachment`. All are enrolled in
  [`src/prisma.scoped-models.ts`](src/prisma.scoped-models.ts), cross-checked against the schema by
  `tests/data-model/account-scope-coverage.spec.ts`.
- Isolation extension: [`libs/common/src/account-scope.ts`](../../libs/common/src/account-scope.ts).

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`, **`AUTH_GRPC_TARGET`**, **`USERS_GRPC_TARGET`**. Validated at boot
by [`src/config.ts`](src/config.ts).

**Cross-service dependency (new in 014):** chats → **auth** (`ResolveEffectivePermissions`) to resolve a
rule author's live permissions. Acyclic — auth never calls chats. Without the dial target every rule
would refuse (fail-closed), which is safe but useless, so it is a boot requirement.

**Cross-service dependency (new in 016):** chats → **users** (`ClaimUploads` / `DescribeUploads`) for
message attachments. Acyclic — users never calls chats. Because the config guard is refuse-to-start,
adding a cross-service client to chats is always a **two-file change**: this key and the matching entry
in `compose.yaml`. Omitting either is a boot failure rather than a runtime surprise, which is the point.

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
