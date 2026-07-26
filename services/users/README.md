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
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`. Validated at boot by [`src/config.ts`](src/config.ts).

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
