-- Feature 024 (roadmap 5.3, ADR 0039) — groups: the entity, membership, and permission grants.
--
-- Purely ADDITIVE: three new tables, no column added to and no constraint changed on anything that
-- already exists. Nothing needs a backfill, and every existing effective-permission answer is
-- unchanged until an operator creates a group and grants something through it (ADR 0039 §7 — the
-- capability ships, the shipped configuration restricts nothing).

-- The unit itself. `name` is operator-authored; nothing in the product branches on it.
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- Membership. The composite primary key IS the idempotence guarantee for "add someone who is
-- already a member": it cannot produce a second row, with no application-level check to race.
CREATE TABLE "GroupMember" (
    "group_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("group_id","user_id")
);

-- What the group confers. NOTE THE ABSENCE of a `granted` column — unlike "UserPermissionEntry",
-- which has one because it is a materialised snapshot that must be able to say "explicitly not".
-- A group grants and never denies (ADR 0039 §3), so a denial is made unrepresentable rather than
-- merely unused: the row's existence is the grant, and revoking deletes it.
CREATE TABLE "GroupPermission" (
    "group_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "GroupPermission_pkey" PRIMARY KEY ("group_id","permission_id")
);

-- One account cannot hold two groups an administrator would be unable to tell apart. The service
-- trims before writing and maps the violation to a named refusal rather than letting it escape.
CREATE UNIQUE INDEX "Group_account_id_name_key" ON "Group"("account_id", "name");
CREATE INDEX "Group_account_id_idx" ON "Group"("account_id");

-- The resolver's hot lookup on every cache miss: "which groups does this user belong to?"
CREATE INDEX "GroupMember_user_id_idx" ON "GroupMember"("user_id");
CREATE INDEX "GroupPermission_permission_id_idx" ON "GroupPermission"("permission_id");

-- Cascades, all of them deliberate:
--   • deleting a GROUP drops its memberships and grants — and no staff member (FR-005);
--   • deleting a USER drops their memberships — a group survives losing a member;
--   • deleting a PERMISSION drops the grants naming it, which keeps the catalogue closed:
--     a grant can never outlive the key it refers to.
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupPermission" ADD CONSTRAINT "GroupPermission_group_id_fkey"
    FOREIGN KEY ("group_id") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GroupPermission" ADD CONSTRAINT "GroupPermission_permission_id_fkey"
    FOREIGN KEY ("permission_id") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;
