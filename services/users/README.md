# users

User directory / profiles service. **State:** a bootable **gRPC microservice** serving the
**players + operators read API** (`UsersReadService` — feature 018, roadmap 5.1), the unified audit
reader, the upload store and artefact expiry, plus `HealthService.Check` and `PingService`.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50052**) implementing `HealthService.Check` **and**
  `PingService.Ping` (echoes the message, stamps `servedAt` — proves the value crossed the wire).
- Owns its **own** database `users_db` via role `users_user` (Principle VIII isolation).
- Data model (feature 006): `Operator`; `Player` ("Player-lite", ADR 0032 §0.1) keyed by `player_id`,
  unified across 1..N brands via the `PlayerBrand` edge (soft `brand_id`, no cross-service FK), with an
  **opaque** GR8-cache seam (`gr8_snapshot`/`gr8_fetched_at`/`gr8_stale` — GR8's typed projection is 7.4).
  Contact-access records go on the unified `AuditEntry` trail as `contact.reveal` (feature 015 absorbed
  and dropped 011's separate `ContactViewAudit` table).
- Read paths: [`src/player/player.repository.ts`](src/player/player.repository.ts) — `getPlayerById` +
  `listByBrand` (keyset) — and [`src/operator/operator.repository.ts`](src/operator/operator.repository.ts).
  Neither can write: no Prisma write op exists in either, asserted by `tests/users-read/no-outbound.spec.ts`.
- **Anti-pitching masking (feature 011, US4 — LIVE since 018):** the owning service masks contact fields
  in the policy layer — `maskPlayer(player, roleKey)` builds the response by ALLOW-LIST from the caller's
  role tier, so fields a role may not see are **structurally absent** (not nulled — FR-014). Tiers live in
  `@crm/common` [`field-tiers`](../../libs/common/src/policy/field-tiers.ts)
  (`open`/`operational`/`am_only`/`masked_pii`). ⚠️ **An unclassified field is visible to NOBODY, not even
  `super_admin`** — the allow-list is built by filtering the tier map, so an unlisted field belongs to no
  tier and lands in no role's permitted set. (The shipped comment claimed it "defaults to `masked_pii`",
  i.e. stayed visible to the cleared tiers; corrected at 018/T047a — the behaviour was always the safer
  one.) Every read surfacing a maskable tier writes ONE `contact.reveal` (tier NAME only, never a value —
  SEC-AP3), **strictly**: an unwritable entry refuses the read. `assertCanMassExport(roleKey)` guards the
  **bulk list** (SEC-AP2 — its first live surface; the export half is still only a build gate).
  See [`src/player/`](src/player).
- Isolation (feature 007): tenant data is read/written ONLY via `PrismaService.forAccount(accountId)`
  (account-scoped client; fail-closed) — see [`libs/common/src/account-scope.ts`](../../libs/common/src/account-scope.ts).
  The player-union (brands) is preserved under scope — the brand carve-out is brand-level, never
  account-level. Raw `$queryRaw` (health `SELECT 1`) is an audited escape hatch (no tenant data).

## Interfaces
- Owned gRPC contract: [`libs/proto/crm/users/v1/users.proto`](../../libs/proto/crm/users/v1/users.proto).
  ⚠️ `UsersReadService` is implemented across **TWO** controllers — `PlayerReadController` (the three
  reads) and the audit reader. Nest merges them into one gRPC service, and `src/maintenance/hosting.spec.ts`
  asserts all four methods actually answer: a handler map that silently drops one is feature 015's
  live-only defect. Plus [`health.proto`](../../libs/proto/crm/health/v1/health.proto),
  [`ping.proto`](../../libs/proto/crm/ping/v1/ping.proto).
- DB schema (its own): [`prisma/schema.prisma`](prisma/schema.prisma) → `users_db`.

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`, the six `S3_*` keys (feature 016 — see below),
`CONTACT_HASH_SALT` (feature 020, min 32 chars), and the two presence thresholds
`PRESENCE_AWAY_AFTER_SECONDS` / `PRESENCE_OFFLINE_AFTER_SECONDS` (feature 025 — 🅿 **PROVISIONAL**,
revised by ops).
Validated at boot by [`src/config.ts`](src/config.ts); the error names the KEY, never the value.

The salt has **no default on purpose**. An unsalted hash of an email is a dictionary lookup away from
the address, and a service that booted without one would build a table of recoverable customer
contacts while answering every request correctly and keeping every test green. That failure has no
symptom, so it is refused at startup rather than detected later.

## Run / test
```bash
npm run test --workspace services/users
```
Runs as part of `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Gotchas
- Hosts two gRPC packages from one microservice (`package`/`protoPath` arrays in `main.ts`).
- Does **not** connect to Postgres at boot — a downed DB degrades health, not startup.
- **The masking input is `x-actor-effective-role`, NOT `x-actor-role`.** The latter carries who the caller
  *is*; masking needs who they are *acting as*, and the two differ exactly under a view-as preview. See
  [`src/player/actor.ts`](src/player/actor.ts) — it deliberately substitutes no default for an absent role,
  because the tier policy already treats an unknown role as open-only and a default here would put a
  privilege decision inside a metadata reader.
- **`gr8_snapshot` stays opaque here.** Typing or decoding it is roadmap 5.4, which must also distinguish
  *not cached yet* (→ `stale`) from *outside GR8's 180-day horizon* (→ not available at this tier). Doing a
  little of that projection early is how those two very different empty states get collapsed into one
  wrong answer.

## ⚠️ A player is `(account_id, brand_id, player_id)` (feature 020, roadmap 5.2 / ADR 0038 §3)

**Read this before touching anything player-shaped.** GR8's `player_id` is unique only **within a
brand**: the same value under brand A and brand B is routinely **two different human beings**. Until
2026-07-29 this service used it as the whole primary key, so those two collapsed into one row — one
card, one VIP flag, one set of AM notes — and the conversation feed served one customer another's
messages. GR8's own contract says as much: `/players/find` answers with `brand` alongside `playerId`.

- The triple is formed, compared and validated in **one place** —
  [`src/player/player.identity.ts`](src/player/player.identity.ts). A caller holding only a platform
  id **cannot construct one**, which is why the composite natural key was chosen over a surrogate:
  every stale call site fails to compile instead of quietly resolving the wrong person.
- `account_id` **leads** the key: the isolation predicate the extension injects stays index-aligned,
  and two future licensees can both hold player `12345`.
- `PlayerBrand` is **gone**. A row *is* one brand's player.
- A read addressed by a platform id with no brand is **refused as ambiguous**, never answered with a
  match. Same for the conversation feed.
- `identity.structure.spec.ts` fails on a bare `where: { player_id }` anywhere in the service, and on
  any second place that assembles the triple as a loose literal.

### Two records, one human

A person spanning brands is an explicit, reversible link — `Person` / `PersonMember`, built by
[`src/player/person.service.ts`](src/player/person.service.ts). It is created **automatically** when
two records share a normalised email or phone, and **never** when they share a platform id.

The evidence lives in `ContactMatch` as a **salted hash and never a value**: a plaintext column would
be a new PII surface the tier policy does not classify, masking does not cover and exports do not know
about. Populated by the GR8 connector at roadmap **7.4**; seeded directly until then.

Three refusals, each for its own reason: never on a shared platform id, never across accounts (the
search itself is account-bounded, so a foreign match is not *rejected* — it is not *found*), and never
on an identifier held by more than two records. That last one is not a hedge against the rare wrong
link the operator accepted; it addresses a different failure — one support placeholder would fuse
strangers **in bulk**.

A link **copies no data**. That is what makes an automatic decision correctable: unlink and two
independent records remain, with nothing to restore. Both halves are audited (`player.link` /
`player.unlink`), carrying the identifier **kind** and never its value.

## An operator profile comes into being (MVP block W1, roadmap 5.10)

The join nobody owned: registration wrote `User` + `Credential` + `UserRole` into `auth_db` and stopped,
while being *assignable* needs an `Operator` row here — and **nothing in the product ever created one**,
only the seed. `AssignPlayer` answered `no such manager` for a manager who plainly existed.

- **gRPC surface** (additive, in the owned contract): `OperatorProfileService.EnsureOwnOperator` —
  [`src/operator/operator-profile.grpc.controller.ts`](src/operator/operator-profile.grpc.controller.ts).
  A separate service because a write on `UsersReadService` is a lie the read-shape guard enforces.
- ⭐ **The subject is the caller and cannot be a parameter** — the request message is **empty**; account
  and identity come from `x-actor-account-id` / `x-actor-user-id`. That is what makes it safe to call
  from the gateway's `@Public` registration tail, and it is the shape roadmap **5.11** will inherit.
- **No permission is checked, deliberately** (the reason is in the controller): the capability is
  *exist*, and the profile is what a new person needs **before** an administrator can act on them.
- **Called by the gateway on registration AND on every login** — the second is the repair path for
  people who registered before this shipped. Idempotent; failure never costs anyone their session.
- **Guarantees in the schema, not in code:** `@@unique([account_id, auth_user_id])` (an upsert without
  it admits a twin profile for one human being), and a re-ensure **never overwrites** `display_name` —
  a login that refreshed it would undo the person's own edit. The name stays NULL here:
  `auth.User.display_name` owns that fact.

## The players + operators read surface (feature 018, roadmap 5.1)

Three RPCs that had been **declared in this contract since Phase 2 and served by nothing** —
[`src/player/player.grpc.controller.ts`](src/player/player.grpc.controller.ts).

- **`GetPlayer`** — order is the design: read → **not found stops here** → mask → audit → wire. A 404
  writes no entry, because nothing was revealed.
- **`ListPlayersByBrand`** — order again, and it is the requirement: context → permission → **bulk guard**
  → brand intersection → query → mask → **ONE** entry targeting the brand. The guard runs **before the
  repository**, so a refused request has read nothing and filed nothing.
- **`GetOperator`** — **no masking and no audit entry, deliberately** (research R8): the visibility policy
  classifies CUSTOMER fields, and a staff display name already renders on every message they sent. Gated by
  `crm.inbox.view`, not the contact key — resolving an assignee is part of using the inbox. *If an operator
  record ever grows a personal field, that decision is the one to revisit.*

⚠️ **The row→wire mapping must stay an EXPLICIT field list.** `maskPlayer` *keeps* `gr8_snapshot` for
`admin`/`super_admin` — they are cleared for its tier. What keeps that customer PII out of every response is
that **the contract has no field for it**, so a `...masked` spread would serve it to every broad role
silently, with every test green. `tests/users-read/tier-agreement.spec.ts` fails on a spread.

Brand narrowing is **deferred to 5.2**: `resolveListBrand` applies an intersection only when the caller's
brand set is populated, mirroring what the conversation reads already do. Until Brands ships, a caller may
list any brand *within their own account* — account isolation is unaffected.

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

**Writer in this service:** `contact.reveal` — one entry per read that surfaces a maskable tier, recording the
most sensitive tier surfaced and never a field value (SEC-AP3). This absorbed feature 011's `ContactViewAudit`,
which is gone.

⚠️ **No live caller yet.** The player-read gRPC handlers that call `ContactViewAuditService` are Phase 5
(roadmap 5.1). When they land they must call **this** writer rather than invent a second store — inventing one
is exactly how feature 011 ended up with two audit tables, which feature 015 then had to merge.

Its failure behaviour is deliberately strict and outranked a later decision: feature 015 initially planned
best-effort recording for data-access classes, and this path's existing choice (*a failed write is not
swallowed*) changed that. An unaudited PII reveal is the harvesting vector SEC-AP3 exists to detect, not a
lost statistic.

## The upload store (feature 016, roadmap 4.9) — SEC-1

⚠️ **This is the only service in the product that can reach the object store.** That is the load-bearing
property of the whole feature, not an implementation detail: "one validated path" (FR-001) is checkable
only because validation and storage are the *same* component. If the gateway could write to the bucket,
any future gateway code could, and the single-path guarantee would be a convention again — which is
exactly the SEC-1 defect this closed.

The property is enforced structurally, not by review:
[`tests/uploads/single-ingest-path.spec.ts`](../../tests/uploads/single-ingest-path.spec.ts) fails the
build if a second file imports `@aws-sdk/client-s3`, if a second service declares `S3_*`, if any other
proto message grows a `bytes` field, or if anything anywhere signs a URL.

- **Owns** the `Upload` table in `users_db`, the object-store credentials, the content validation and the
  image codec. Bytes live in a **private** S3-compatible bucket (MinIO locally and on `beton-test`, a
  managed bucket in production — one client, `endpoint` + `forcePathStyle` is the whole difference).
- **Code:** [`src/uploads/`](src/uploads) — `object-store.ts` (the sole SDK importer, plus an in-memory
  fake so Track A needs no Docker), `validate.ts` (purpose → size → magic bytes → decode),
  `image.ts` (sharp; **untrusted-input handling**, not a formatting utility), `uploads.repository.ts`,
  `uploads.grpc.controller.ts`.
- **Vocabulary is shared, enforcement is here:** the closed purpose catalogue and the magic-byte table
  live in [`libs/common/src/uploads`](../../libs/common/src/uploads) because the gateway needs the parse
  limit and the first-tier permission. **Adding a consumer is adding a catalogue ROW** — a test asserts no
  validation code branches on a purpose name.
- **gRPC surface** (additive, in the owned contract): `UploadsService.CreateUpload` / `ReadUpload` /
  `ClaimUploads` / `DescribeUploads`. Deliberately absent: no update, no delete, no presign, no
  upload-on-behalf-of. Both id-list RPCs are capped at 50 — an unbounded `repeated string` on an
  authenticated path is an unbounded request.
- **Reads are brokered, never signed.** Authorization is evaluated at request time against the caller's
  current account and permissions (FR-010), which is why a leaked link is worth nothing: a signed URL
  would move that decision to link-creation time, i.e. the SEC-10 case.
- **The decoder cuts both ways, on purpose.** It is attack surface, but re-encoding is the only
  *structural* answer to a polyglot file. `limitInputPixels` is **mandatory** — a byte cap limits what we
  accept, never the memory needed to decode it, and a 40 KB PNG can declare 50 000². Re-encoding also
  strips EXIF (GPS included) from the derivative; the *original* still carries it and is served only on a
  deliberate open.
- **Not audited, and no action is defined either** (spec Q2). An upload is ordinary work, like posting a
  message, and the message already answers "who sent this to the customer". A catalogue entry added "in
  case" is an invitation — so its absence is asserted by a test.
- **Failure direction, chosen not defaulted:** the object is put *last* before the row, and a failed row
  write deletes it and logs a discrepancy (keys only, never a filename — a filename can itself be PII).
  Across the chats boundary the claim comes *before* the message write: wasted bytes beat a dangling
  reference a future reclaim job would delete.
- **Growth is bytes, not rows** — the first thing in this product for which that is true. The
  `(account_id, state, created_at)` index exists so the eventual retention job (ADR 0015) is a cheap
  query rather than a table scan.

## Artefact expiry — the one path that removes bytes (feature 017, roadmap 4.10)

⚠️ This **narrows** feature 016's "nothing in v1 removes bytes". Narrows, not weakens: an artefact whose
defining property is that it *expires* cannot honour that rule, and a status flag saying `expired` while
the object sits in a bucket is SEC-27 rather than a fix for it.

The narrowing is structural on four axes, all asserted by
[`tests/uploads/single-ingest-path.spec.ts`](../../tests/uploads/single-ingest-path.spec.ts):

1. **A separate gRPC service** — `UsersMaintenanceService.PurgeExpiredArtefacts`. `UploadsService` still
   has exactly four requester verbs and no update, delete, presign or sign.
2. **Only `ephemeral` purposes are selectable**, and that set is **derived** from the catalogue
   (`EPHEMERAL_PURPOSE_NAMES`) — an avatar or an attachment is unreachable *by construction*, not
   excluded by a list somebody has to maintain.
3. **System actor only**, and the gateway exposes no route to it.
4. **One delete issuer** — `object-store.ts`, the same file as every other S3 command.

- **Code:** [`src/uploads/artefact-purge.repository.ts`](src/uploads/artefact-purge.repository.ts) (bytes,
  beside the credentials it needs) + [`src/maintenance/`](src/maintenance) (the scheduling-facing service
  and the RPC). The maintenance module *imports* `UploadsModule` rather than constructing its own store
  client — a second credential holder is exactly what the structural test exists to prevent.
- **Object BEFORE row** — the reverse of the create path, deliberately. Create's worst residue is an object
  with no row; here it is the opposite: a row deleted while its bytes survive leaves data no later pass can
  find. A storage failure therefore leaves the row exactly where the next tick will find it.
- **Idempotent by construction**, with no bookkeeping: a purged row is *gone*, so it leaves the predicate.
  There is no "purged" flag to reconcile and no window where a row is marked done but its bytes are not.
- **`object_missing` is a NORMAL outcome**, distinct from "deleted" and from "storage refused" — which is
  why `ObjectStore` gained `exists()`: S3 deletion is idempotent and silent, and using `get` would pull a
  whole artefact over the wire to learn one boolean about bytes we are about to destroy.
- **`Upload.expires_at`** is the predicate and lives here, on the row the credential holder owns, so
  deletion never depends on another service being reachable. The export record in `chats_db` carries the
  same computed value for the product-facing answer; both derive from one catalogue constant.

## The operator's own UI preferences (feature 021, roadmap 5.6) — the surface with NO permission

Theme mode and font-size step, per person, so settings follow someone between machines. Browser-local
storage cannot do that; the cookie at 8.8 is only the server-rendering mirror, never the record.

**⚠️ NOT `Player.preferences_json`.** That column is the **customer's** preferences — VIP portfolio
data about a real human being, tier `am_only`, masked from most roles. This table is an employee's own
appearance: cosmetic, self-owned, readable by nobody else. Two different things, named apart so a grep
for one never returns the other (`src/preferences/boundary.spec.ts` enforces it in both directions).
The 4.15 gap survived seven features because "custom attributes" existed on `Player` while the
requirement meant `Conversation`, and the name being taken made everyone assume the thing was built.

- **gRPC surface** (additive, in the owned contract): `OperatorUiPreferencesService.GetOperatorUiPreferences`
  / `UpdateOperatorUiPreferences`. A **separate** service, not two rpcs on `UsersReadService` — a write
  on a service named *Read* is a lie in the contract. `src/maintenance/hosting.spec.ts` asserts all four
  hosting links, because a new service in an existing package is the case most likely to be assumed.
- **Catalogue**: [`libs/common/src/preferences/ui-preferences.ts`](../../libs/common/src/preferences/ui-preferences.ts)
  — closed and additive, the sixth in this product. Adding a key is a row there and nothing else: no
  migration, no backfill, no change to the read path.
- **Table**: `OperatorUiPreference`, keyed `(account_id, auth_user_id, key)`. See
  [`prisma/schema.prisma`](prisma/schema.prisma).

### Gotchas

- **One row per key, deliberately.** A JSON column *is* the untyped bucket this feature exists to
  prevent — validation would live only here while the database accepted anything. Per-key rows also
  make a partial write an upsert, so two tabs changing different settings cannot clobber each other
  with no locking anywhere.
- **A read creates nothing.** Absence is answered from the catalogue. Materialising a row on first
  read would mean every page render writes.
- **Keyed by the authenticated person, not by `Operator`.** The session already carries account and
  auth user id, and `Operator.auth_user_id` is a soft ref this project never joins. It also works
  before an `Operator` row exists.
- **A stored key or value the catalogue no longer defines is IGNORED on read**, never an error —
  otherwise retiring a key or narrowing a value set would be a data migration.
- **Validate the whole patch, then write.** A partially applied write is the worst outcome available:
  the caller gets an error and the record changed anyway.
- **Refusals name the key and never the value.** Echoing arbitrary submitted input into a message is
  how it reaches a log (Principle IV).
- **No permission, and none may be added.** ADR 0035's hard boundary: hiding something through a
  preference is not a restriction, and revealing something through one cannot grant access. The
  boundary spec asserts this path reads no permission set and no role.
- **Not audited, on purpose.** 0019/SEC-29 records sensitive actions; ~58 agents toggling a theme
  several times a day would bury the entries that matter. The reason is stated at the write path so
  the absence does not read as an oversight.
- **⚠️ The REST routes must keep `@ResolvesPermissions()`.** Without it the gateway never populates
  `req.effective`, `x-is-preview` is never forwarded, and this service's preview refusal becomes
  unreachable — with every test still green, because the gateway's own write-block already covers the
  case. Pinned by `services/gateway/src/preferences/ui-preferences.spec.ts`.

---

## `ListOperatorsByAuthUsers` (feature 024, roadmap 5.3)

AUTH user ids → **active** operator profiles. One rpc, added so a group's membership can become a routing
candidate pool: membership is keyed on the auth identity (the subject the permission resolver keys on),
while a conversation's assignee is an operator profile, and the two live in different databases.

- Gated by **`crm.conversation.assign`**, not the inbox key: the only reason to ask is to route work. The
  caller's own metadata is forwarded unchanged — calling as a system actor would launder the permission.
- **Active profiles only.** A member with no profile, or an inactive one, is simply absent and is therefore
  not a routing candidate (fail-closed). The gap between what was asked for and what came back is what makes
  a thin pool explainable.
- Carries no customer data at all, so nothing to mask and nothing to audit as an access.
- **Since feature 025 it also answers with AVAILABILITY** (`state` + `blockedChannels`), because this is
  the rpc the routing pool already calls — so the hot path gained a *fact* rather than a *hop*. The
  enrichment lives in `OperatorRepository.resolveByAuthUserIds`, not in the controller: **one method
  answers "who can take this work?" completely**, and splitting the two conditions across layers is how
  a caller ends up applying one and forgetting the other.

## Player ↔ account-manager assignment (feature 026, roadmap 5.7)

Which player is looked after by which manager — the entity replacing the Excel portfolio, and the
prerequisite for the 4.14 ticket scope and the 9.10 "my players" list.

**⚠️ ATTACHMENT GRANTS ACCESS.** A row hands the manager the player's portfolio, preferences and AM
notes. Not a "mine" marker: a grant of access to data about a real human being. Everything below
follows from that.

**⚠️ THIS POINT NARROWED SOMETHING ALREADY SHIPPED, and that is its real content.** Before it, the
`am_only` tier was gated **by role alone** — any AM-role caller read every player's portfolio. Now:

```
sees am_only  ⟺  role has am_only  AND  ( role has masked_pii  OR  attached to this player )
```

The rule is **derived from the tier map**, not from a list of role names: `masked_pii` *is* the
administrative clearance, so administrators stay exempt and a future role added to either tier is
handled correctly without anybody remembering. Two boundaries keep it coherent: administrators are
exempt (their reads are already audited), and **only `am_only` narrows** — `open` and `operational`
stay role-gated, or an AM could not see enough of an unattached player to attach them.

**The five readers of the tier, and what each does** (`tests/users-read/am-tier-requires-attachment.spec.ts`
pins the list, so a sixth has to argue for itself):

| Reader | Narrows | Why |
|---|---|---|
| `GetPlayer`, `ListPlayersByBrand` | yes | they name a record |
| `contact-view-audit` `recordView` | **yes** | names one player — an entry claiming an unattached AM surfaced the tier would **overstate** the trail whose job is detecting over-reach |
| `contact-view-audit` `recordBulkRead` | **no** | names a **brand**, so there is no single attachment to ask about; narrowing would **understate** |
| `canMassExportContacts` | no | a role-level gate with no record in view |

**Storage.** `PlayerAssignment`, keyed on the player's full `(account, brand, player_id)` identity and
on the manager's **auth identity** (not the operator profile id — the narrowing asks *"is the CALLER
attached?"* on every masked read, and the caller is an auth identity; the profile is validated at
write time instead). A **partial unique index** filtered to `ended_at IS NULL` gives one active
manager per player *and* additive history at once — widening later is `DROP INDEX`, not a reshape.

**⚠️ Self-assignment is an intended route to the AM tier**: attach, read, detach. The operator asked
for self-service explicitly, so the control is the **audit** rather than a refusal — every attach and
detach writes exactly one entry, with `selfAssigned` and `managerRef`, and the third index exists
only so *"who attached how many, and when"* needs no scan. There is **no alerting surface** (none
exists yet — 7.1/7.3), no bulk-assign verb (that would be the harvesting vector), and no
`TransferPlayer` (a move is two audited acts, and Q3.1 is still open).

## Agent presence (feature 025, roadmap 5.9) — for ROUTING only

Four states — `online` · `transfers_only` · `away` · `offline` — narrowable per channel, lowered
automatically when a session goes quiet, and recorded as durable history on every real change.

**⚠️ Presence is not `Operator.active`.** `active` means the staff account is not deactivated (roadmap
3.16): that person has **left**. Presence means they are not at their desk **right now**. Both make
somebody unavailable and they are not interchangeable — `resolveByAuthUserIds` is the one query where
they meet, and `tests/naming/presence-is-not-active-nor-status.spec.ts` keeps them apart. The word is
**state**, never "status", which is already taken three times over.

**⚠️ This service is the SECOND writer of the durable transition stream, and the first outside chats.**
U7 forbids a shared cross-service table, so `OperatorTransition` is its own table — but it is
**column-for-column identical** to `chats.ConversationTransition`, because the B2 aggregate store reads
one logical stream. The row BUILDER is shared
([`libs/common/src/transitions/row.ts`](../../libs/common/src/transitions/row.ts)) so identical rows are
true by construction; `tests/data-model/one-transition-envelope.spec.ts` compares the two *tables*,
which is the half a shared function cannot cover.

**Surfaces.** Reads on `UsersReadService` (`GetOperatorPresence`, `ListOperatorPresence` — a THIRD
controller on that service). Writes on `OperatorPresenceService`, a new service in the existing package,
because a guard requires every rpc on a service named *Read* to be read-shaped. The sweep is on
`UsersMaintenanceService`: system-actor-only, no gateway route, counts in the response — placement is
the security property, since a sweep reachable from a session would put a colleague offline without the
key that governs exactly that.

**Two rules worth knowing before editing anything here:**
- **A no-op writes nothing.** Setting a state to the value already held returns `unchanged` and records
  zero transitions. A no-op that recorded would inflate every future WFM figure at the source, and each
  individual row would still look correct.
- **The sweep only LOWERS; a heartbeat raises only what the sweep set.** That is why `last_cause` is a
  stored column and not derived from the history: answering *"how did this state come to be?"* on the
  hottest write path must not be a scan. Without it, an open browser would undo a person's own "Lunch"
  and — worse — undo a supervisor's correction with the very stale session that made it necessary.

**Audited exactly once, and only one act.** Changing one's own presence writes a transition and **no**
audit entry (a statement about oneself is not a sensitive action; ~58 agents toggling several times a
day would bury the entries that matter). Setting *somebody else's* requires `users.presence.manage`, is
audited as `presence.override`, and records `cause: admin`. ⚠️ That entry carries **no detail**: the
`privilege` class's allow-list is about permissions, and an override changes none — the transition
written in the same transaction already says from/to/why.

**Deliberately NOT here** (asserted by `tests/presence/no-aggregates.spec.ts`, because the roadmap
requires the absence not be added quietly): no aggregate, dashboard, adherence, occupancy or attendance
calculation — WFM later *reads the stream*; and no session id, device id or screen/panel telemetry —
the employee-surveillance question is separate and undecided.

## The channel participant: who wrote, and where to answer (feature 033, roadmap 6.4)

⭐ **This service owns the customer's channel address because it already owns contact values.** Replying
to an email needs the address the customer wrote **from**; a salted hash cannot give it back, and the
player's registered address must not stand in for it - they may differ, and answering the wrong one
delivers a stranger's conversation to somebody.

So `ChannelParticipant.address` is stored **in clear, deliberately**, here, where the masking regime, the
field-tier policy and `CONTACT_HASH_SALT` already are. `chats` receives an opaque handle. The rejected
alternative was storing it beside the conversation, which would have made a service with no masking
regime the owner of a contact value.

**Resolution is conservative by construction** (`channel-participant.service.ts`):

- **brand-scoped** - the same address under another brand is another person until a `Person` link says
  otherwise;
- **more than one candidate means nobody**, flagged `ambiguous` so a reader can tell "nobody has this
  address" from "several do and we declined";
- **no match means unidentified, stated** - never a generated stand-in name, never `***`;
- email/phone resolve against **feature 020's `ContactMatch` projection**, reused rather than
  reimplemented, which is what makes *"no new matching surface over contact values in clear"* true by
  construction. A platform id resolves by **existence** in `(account, brand)` and gets no envelope row.

⚠️ **The salt is INJECTED (`CONTACT_HASH_SALT` provider), not read per message.** The first draft called
`loadUsersConfig()` inside the resolution and caught the failure - which meant a deployment with no salt
would answer every request correctly, keep every test green, and quietly mark every arriving conversation
as belonging to nobody.

⚠️⚠️ **`GetChannelEnvelope` is the one rpc in the product that returns an unmasked contact value.** Its
terms: the outbound delivery path only, no gateway route, never logged, account-scoped - and a handle
from another account answers `NOT_FOUND` rather than an empty envelope, because an empty answer could be
swept to learn which handles exist elsewhere.
