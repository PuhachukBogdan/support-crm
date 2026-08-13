# auth

Authentication / identity service. **State:** a bootable **gRPC microservice** that owns `auth_db`
and implements the **login & session engine** (feature 009) plus the **account lifecycle** (feature
010) — two-step login, JWT issuance, rotating sessions, lockout, super-admin whitelist onboarding,
admin invites, and invited-user registration — alongside `HealthService.Check`. It also **owns the
RBAC model** (feature 011): the permission registry, role defaults/templates, copy-on-write per-user
overrides, privilege-change audit, and effective-permission resolution. Enforcement runs in the
shared policy lib at the gateway + owning services; contact-field masking lives in `users`; the
"view-as-role" preview is at the gateway.

## Responsibility & boundaries
- gRPC server (`GRPC_URL`, compose port **50051**) hosting `AuthService` + `HealthService`.
- Owns its **own** database `auth_db` via role `auth_user` — no cross-service DB access (Principle VIII).
- **Two-step login for all roles** (feature 009): `Login` verifies email+password and issues a one-time
  emailed code (no token yet); `VerifyLoginCode` consumes the code and mints the token pair. No
  credential-only path to any session — super-admin included (SEC-2). Short access JWT + rotating,
  DB-backed refresh (session = ~1d, ~7d with "remember me"); rotation revokes the prior token and
  detects reuse. Lockout after 5 consecutive failures (SEC-14) with an identity-only admin notice.
- **Account lifecycle (feature 010):** super-admins appear ONLY from the out-of-band
  `SuperadminWhitelist` — a generic `RequestActivation` (anti-enumeration) emails a code, then
  `CompleteActivation` sets a policy-compliant password and creates the active super-admin.
  Admin/super-admin issue **single-use, expiring invites** (`CreateInvitation`, hierarchy-enforced,
  rate-limited); the invited user **registers** (`StartRegistration`/`CompleteRegistration`) with a
  matching email + fresh emailed code + policy password. Set-time **password policy** (min length +
  upper/digit/symbol, configurable) is enforced at every set-password surface. Codes reuse `LoginCode`
  (purpose `activation`/`registration`); the target `User` is pre-created non-active (`pending`/`invited`).
- **RBAC (feature 011):** owns the permission model — `ListPermissionCatalogue`/`ListRoleDefaults`
  (registry by category, versioned; role templates), the copy-on-write personalization
  (`PersonalizeUser`/`PersonalizeGroup`, single-role group, `ResetToDefault`), `AssignRole`
  (refuses `super_admin` — whitelist only), and `ResolveEffectivePermissions` (the resolver the
  gateway calls on a cache miss). Management RPCs are super-admin-gated server-side (FR-018); every
  mutation writes a `PrivilegeAudit` (references only, no PII — 0019/SEC-29). Role defaults come from
  `src/rbac/catalogue.ts` (`ROLE_DEFAULTS`), also the whole-role reset source. See `src/rbac/`.
- Data model: `User` (+ `failed_login_count`/`locked_until`; statuses `active`/`disabled`/`pending`/`invited`),
  `Credential` (argon2id `secret_hash`), `Role`/`UserRole`, feature-009 `LoginCode` / `RefreshToken`,
  feature-010 `SuperadminWhitelist` / `Invitation`, and **feature-011** `Permission` / `RolePermission`
  / `UserPermissionSet` / `UserPermissionEntry` / `PrivilegeAudit` — every tenant table carries an
  indexed `account_id` seam (ADR 0003).
- Isolation (feature 007): tenant data flows via `PrismaService.forAccount(accountId)` (fail-closed) —
  see [`libs/common/src/account-scope.ts`](../../libs/common/src/account-scope.ts). The **pre-login
  credential lookup runs unscoped** (it *establishes* `account_id` — research R7); minted tokens are
  account-bound (regression-tested).

## Interfaces
- Owned gRPC contract: [`libs/proto/crm/auth/v1/auth.proto`](../../libs/proto/crm/auth/v1/auth.proto)
  (`AuthService`: `Login`→`LoginChallenge`, `VerifyLoginCode`, `ValidateToken`, `Refresh`, `Logout`,
  `ResendLoginCode`; **feature 010:** `RequestActivation`, `CompleteActivation`, `CreateInvitation`,
  `StartRegistration`, `CompleteRegistration`; **feature 011:** `ResolveEffectivePermissions`,
  `ListPermissionCatalogue`, `ListRoleDefaults`, `SetRoleDefault`, `PersonalizeUser`,
  `PersonalizeGroup`, `ResetToDefault`, `AssignRole`) + [`health.proto`](../../libs/proto/crm/health/v1/health.proto).
- DB schema (its own): [`prisma/schema.prisma`](prisma/schema.prisma) → `auth_db`.
- Outbound seams: `EmailPort` — **now really delivers** (feature 028, see below) — and
  `AdminNotificationPort` (identity-only lockout alert), both in `src/auth/ports/`.
- **feature 028:** `SendDueEmails` — the worker's mail tick. Counts in, counts out; nothing about a
  message crosses the wire.

## Config (refuse-to-start, SEC-6)
`NODE_ENV`, `GRPC_URL`, `DATABASE_URL`, **`JWT_SECRET`** (secret — shared with the gateway for local
verify). Tunables with safe defaults (overridable): `ACCESS_TTL`, `SESSION_TTL`, `REMEMBER_TTL`,
`CODE_TTL`, `CODE_LENGTH`, `CODE_MAX_ATTEMPTS`, `LOCKOUT_THRESHOLD`, `LOCKOUT_WINDOW`, argon2 cost;
**feature 010:** `PASSWORD_MIN_LENGTH` + `PASSWORD_REQUIRE_UPPERCASE`/`DIGIT`/`SYMBOL`, `INVITE_TTL`,
`INVITE_RATE_MAX`/`WINDOW`, `ONBOARD_REQUEST_RATE_MAX`/`WINDOW`. Validated at boot by
[`src/config.ts`](src/config.ts).

**feature 028 (mail)** adds three to the refuse-to-start tier — **`MAIL_HOST`**, **`MAIL_FROM`**,
**`APP_BASE_URL`** — and tunables `MAIL_PORT`, `MAIL_USER`/`MAIL_PASSWORD`, `MAIL_SECURE`,
`MAIL_BRAND_NAME`, `MAIL_ALLOWED_RECIPIENT_DOMAINS`, `MAIL_MAX_ATTEMPTS`, `MAIL_SWEEP_INTERVAL_MS`.

⚠️ **`APP_BASE_URL` has no default anywhere, on purpose.** A guessed one emails invitation links that
look perfect and lead nowhere — the defect roadmap 8.6/T033 existed for.
⚠️ **An empty `MAIL_USER`/`MAIL_PASSWORD` means absent, not "a credential of length zero".** Compose
passes unset optionals as `''`; reading that as a value made the service refuse to start against a
catcher that needs no credentials.

## Run / test
```bash
npm run test --workspace services/auth      # Track A: hermetic (mock Prisma, in-memory ports, fixed clock)
npm run prisma:deploy                        # Track B only (apply committed migrations to auth_db); then npm run seed
```
Runs as part of `docker compose up` (see [`deploy/local/README.md`](../../deploy/local/README.md)).

## Mail — the outbox (feature 028)

Contract: [`specs/028-email-delivery/contracts/mail-transport.md`](../../specs/028-email-delivery/contracts/mail-transport.md).
Code: `src/auth/mail/`.

**Auth sends; the worker is only a clock.** A row is written in `OutboundEmail` **inside the same
transaction as the code or invitation it announces**, so "a code exists that nobody will ever send"
is unrepresentable. The send is attempted immediately after the request (never inside it — FR-004),
and the worker's `SendDueEmails` tick sweeps whatever failed. Putting the send in the worker was the
recorded alternative and was rejected: it would put a **live one-time code** into a gRPC payload.

- One renderer owns every word of both messages (`mail/render.ts`), plain text, no remote content.
  ⚠️ The brand is a **configured value with a neutral default** — an authentication email is the
  worst place for a licensee to find our name (Principle VI).
- One transport opens sockets (`mail/smtp.transport.ts`). Failures become a **class**, never the
  relay's own sentence — SMTP rejections quote the envelope. Recipient allow-list is checked
  **before a connection**, so a blocked address is never a TCP session.
- ⚠️ **Timeouts are set explicitly** (10/10/20s). The library default is ~2 minutes, and a send to a
  dead host hung: the row stayed claimed with no attempt recorded, so a failure that must be visible
  within a minute was invisible for two.
- `sent` rows are **deleted**, not marked — kept rows would be a plaintext record of who signed in
  and when, in a table that also holds live codes.
- ⚠️ The plaintext dev sink (`LOGIN_CODE_DEV_SINK`) is **gone**, and `mail-structure.spec.ts` fails
  if it returns. Live rounds read codes from the delivered message.

## Gotchas
- ⭐ **One credential per `(user_id, type)` — a UNIQUE constraint, and `LoginService` depends on it.**
  The password is read with `findFirst({ user_id, type: 'password' })` and **no ordering**, so with two
  rows the hash that gets verified is decided by Postgres row order: a correct password refusable, a
  superseded one still working. Found on the stand (MVP block W1) when the seed began writing real
  hashes and met a credential made by hand during feature 024's live round. Removed at the schema
  instead of patched with an `ORDER BY`, so `findFirst` is deterministic by construction; pinned by
  `prisma/credential-one-per-type.spec.ts`. **Do not add a second password row for a person** —
  changing a password updates the existing one.
- **Seeded people can sign in only when `SEED_DEV_PASSWORD` is set** (roadmap 1.7). No default, by
  design: unset, the seed writes the labelled placeholder it always did and nobody can authenticate, so
  no environment acquires working passwords by accident. Not an MFA bypass — login stays two-step, the
  password only reaches the emailed-code step.
- Codes/passwords/tokens are **never** logged (Principle IV) — nothing on a mail path may take an
  error object or a payload, and a structural test enforces it.
- ⚠️ **SMTP bodies use CRLF.** Anything grepped out of a delivered message carries an invisible `\r`;
  a token extracted that way makes the gateway answer *"Bad control character in JSON"*, which reads
  like a broken endpoint. `tr -d '\r'` in the live scripts.
- Does **not** connect to Postgres at boot — a downed DB degrades health, it doesn't crash startup.
- Access-JWT expiry is real-time (`jsonwebtoken`); OTP/refresh/lockout expiry uses the injectable clock.

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

**Writers in this service:** `role.assign` / `role.revoke` / `permission.grant` / `permission.revoke` /
`permission.reset` (absorbing feature 011's `PrivilegeAudit`, which is gone), plus `audit.read` — reading the
trail is itself recorded, once per read, because "who went looking at who accessed what" is the same
accountability question one level up.

⚠️ **The privilege mutations were restructured** to make that possible: every read happens first, then the
writes **and** the audit entry commit in one batch `$transaction`. Two consequences worth knowing: a failing
audit now refuses the change (it previously left it standing, unrecorded), and the mutation itself became
atomic (it was a sequence of independent writes, so a failure halfway left a user snapshotted-but-not-granted).
`ensureStandalone` was split into `planStandalone` for the same reason — it read and wrote in one go, which
cannot sit inside a batch.

---

## Groups (feature 024, roadmap 5.3 — [ADR 0039](../../cowork/decisions/0039-groups-are-an-access-input.md))

An operator-named unit of staff. `Group` / `GroupMember` / `GroupPermission` in
[`prisma/schema.prisma`](./prisma/schema.prisma); the gRPC surface is in
[`libs/proto/crm/auth/v1/auth.proto`](../../libs/proto/crm/auth/v1/auth.proto).

**⚠️ Why an org-chart entity lives in the identity service.** Both enforcement tiers consume ONE resolved
permission set: the gateway calls `ResolveEffectivePermissions` and forwards the answer as
`x-actor-permissions`, and every service guard reads only that. So there is exactly one function where
"may they?" is answered — `RbacResolverService.resolve`, over `auth_db`. Putting the group anywhere else
would need a gRPC hop **inside the hot permission path**, or a second place that decides access. ADR 0039 §2
forbids the second: two mechanisms that both decide access will diverge, and the divergence is invisible
until someone sees something they should not.

**A group grants and never denies.** `GroupPermission` has **no `granted` column** — unlike its neighbour
`UserPermissionEntry`, which needs one because it is a materialised snapshot that must be able to say
"explicitly not". A row's existence is the grant; revoking deletes it. A denial is unrepresentable rather
than merely unused (`tests/data-model/group-grant-is-positive-only.spec.ts`).

**Where the term enters the resolver.** `effective = ( standalone snapshot OR role defaults ) ∪ ⋃ group
grants`, unioned into **both** real exits and deliberately **absent from the view-as preview** — the preview
answers "what can this ROLE do?", and folding in the caller's own memberships would make it report more
access than the role has. The standalone snapshot stays frozen while the group term is live; that asymmetry
is intentional and is written up beside the method.

**No-escalation.** A caller may confer only a key they already hold. Without it, `platform.group.manage`
(which `admin` has) would be a route to `platform.role.manage` (which `admin` deliberately does not):
create a group → grant it the key → join the group. `group-grant-parity.spec.ts` pins it.

**Permission:** `platform.group.manage` — a new key, in no operational role template. Not
`platform.role.manage`, which is a super-admin exclusive; reorganising a desk is routine.

**Audited:** seven `privilege`-class actions (`group.create` / `group.rename` / `group.delete` /
`group_member.add` / `group_member.remove` / `group_permission.grant` / `group_permission.revoke`), exactly
one entry per accepted mutation, written inside the same transaction as the act.

**Consumers:** chats resolves a routing candidate pool through `ListGroupMembers`; roadmap 9.6a will use a
group as a grant subject for views and folders.

⚠️ **`PersonalizeGroup` in the contract is NOT this.** It means "a hand-picked batch of users edited at
once" (feature 011) and owned the word first. The wire name is kept because renaming an rpc trips
`buf breaking`; in TypeScript it is `OverrideService.personalizeSelection`, and
`tests/naming/personalize-group-disambiguated.spec.ts` keeps the two apart.
