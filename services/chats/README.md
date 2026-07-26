# chats

Core conversations / ticketing service. **State:** a **gRPC microservice** over its **own** Postgres
exposing `HealthService.Check`, the **chats-core domain** (feature 012, roadmap 4.1–4.3 —
conversations, messages incl. protected private notes, player feed) and the **workflow layer**
(feature 013, roadmap 4.4–4.5 — assignment + round-robin, labels, macros, canned responses).
Automations / SLA / audit / uploads / exports (4.6–4.10) and VIP routing (4.11–4.13) are later features.

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
  different capabilities.
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

## Interfaces
- gRPC contracts: [`chats.proto`](../../libs/proto/crm/chats/v1/chats.proto) (own) +
  [`health.proto`](../../libs/proto/crm/health/v1/health.proto). Consumes
  [`users.proto`](../../libs/proto/crm/users/v1/users.proto) /
  [`brands.proto`](../../libs/proto/crm/brands/v1/brands.proto) once those read servers land (Phase 5).
- DB schema (its own): [`prisma/schema.prisma`](prisma/schema.prisma) → `chats_db`. Migrations in
  [`prisma/migrations/`](prisma/migrations) (Track B: `prisma migrate deploy`). Feature 013 adds two
  account-scoped tables — `CannedResponse` and `RoundRobinState` (rotation cursor) — both enrolled in
  [`src/prisma.scoped-models.ts`](src/prisma.scoped-models.ts).
- Isolation extension: [`libs/common/src/account-scope.ts`](../../libs/common/src/account-scope.ts).

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`. Validated at boot by [`src/config.ts`](src/config.ts).

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
- tsx/esbuild emits no decorator metadata → every constructor param uses explicit `@Inject`.
