# users

User directory / profiles service. **State:** a bootable **gRPC microservice** hosting two
packages — `HealthService.Check` (over its own Postgres) and `PingService` — with the Phase-2 data
model + the Player read path in place. Users domain gRPC (`UsersReadService`) arrives in **Phase 5**.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50052**) implementing `HealthService.Check` **and**
  `PingService.Ping` (echoes the message, stamps `servedAt` — proves the value crossed the wire).
- Owns its **own** database `users_db` via role `users_user` (Principle VIII isolation).
- Data model (feature 006): `Operator`; `Player` ("Player-lite", ADR 0032 §0.1) keyed by `player_id`,
  unified across 1..N brands via the `PlayerBrand` edge (soft `brand_id`, no cross-service FK), with an
  **opaque** GR8-cache seam (`gr8_snapshot`/`gr8_fetched_at`/`gr8_stale` — GR8's typed projection is 7.4).
  Feature 011 adds `ContactViewAudit` (actor/player/tier/timestamp — no value; SEC-AP3).
- Read path: [`src/player/player.repository.ts`](src/player/player.repository.ts) `getPlayerById(accountId, playerId)`.
- **Anti-pitching masking (feature 011, US4):** the owning service masks contact fields in the policy
  layer — `maskPlayer(player, roleKey)` builds the response by ALLOW-LIST from the caller's role tier,
  so fields a role may not see are **structurally absent** (not nulled — FR-014). Tiers live in
  `@crm/common` `field-tiers` (`open`/`operational`/`am_only`/`masked_pii`; unclassified ⇒ fail-closed
  `masked_pii`). Every read that surfaces a maskable tier writes a `ContactViewAudit` (tier name only,
  never a value — SEC-AP3); `assertCanMassExport(roleKey)` blocks bulk export for linear roles
  (SEC-AP2). These are the tested units the `UsersReadService` player handlers call when they land
  (Phase 5). See [`src/player/`](src/player).
- Isolation (feature 007): tenant data is read/written ONLY via `PrismaService.forAccount(accountId)`
  (account-scoped client; fail-closed) — see [`libs/common/src/account-scope.ts`](../../libs/common/src/account-scope.ts).
  The player-union (brands) is preserved under scope — the brand carve-out is brand-level, never
  account-level. Raw `$queryRaw` (health `SELECT 1`) is an audited escape hatch (no tenant data).

## Interfaces
- Owned gRPC contract: [`libs/proto/crm/users/v1/users.proto`](../../libs/proto/crm/users/v1/users.proto)
  (`UsersReadService` — bodies in Phase 5) + [`health.proto`](../../libs/proto/crm/health/v1/health.proto),
  [`ping.proto`](../../libs/proto/crm/ping/v1/ping.proto).
- DB schema (its own): [`prisma/schema.prisma`](prisma/schema.prisma) → `users_db`.

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`, and the six `S3_*` keys (feature 016 — see below).
Validated at boot by [`src/config.ts`](src/config.ts); the error names the KEY, never the value.

## Run / test
```bash
npm run test --workspace services/users
```
Runs as part of `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Gotchas
- Hosts two gRPC packages from one microservice (`package`/`protoPath` arrays in `main.ts`).
- Does **not** connect to Postgres at boot — a downed DB degrades health, not startup.

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
