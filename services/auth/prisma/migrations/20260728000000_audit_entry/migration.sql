-- Feature 015 (roadmap 4.8): the general audit trail replaces the feature-011 privilege trail.
--
-- This is the ONLY migration in the feature that MOVES DATA, which makes it the one Track B has to prove
-- against real prior rows: a migration with nothing to move proves nothing.
--
-- Order matters: create the new table, copy every existing row through the action mapping, and only then
-- drop the old one. If the copy fails, the transaction aborts with `PrivilegeAudit` still intact — the old
-- rows are never at risk of being dropped before their replacements exist.
--
-- Authored by hand (dev box has no DB; `auth_user` has no CREATEDB, so Track B applies this with
-- `prisma migrate deploy --schema services/auth/prisma/schema.prisma` — WITHOUT --schema Prisma reports
-- "no pending migrations" against the wrong schema and silently does nothing, the feature-014 lesson).

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL DEFAULT 'user',
    "actor_ref" TEXT,
    "under_preview" BOOLEAN NOT NULL DEFAULT false,
    "action" TEXT NOT NULL,
    "target_ref" TEXT NOT NULL,
    "detail_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the read surface orders by (created_at DESC, id DESC), so `id` belongs in the ordering
-- index — two entries in the same instant must still page deterministically.
CREATE INDEX "AuditEntry_account_id_created_at_id_idx" ON "AuditEntry"("account_id", "created_at", "id");

-- CreateIndex: "what did this user do"
CREATE INDEX "AuditEntry_account_id_actor_user_id_created_at_idx" ON "AuditEntry"("account_id", "actor_user_id", "created_at");

-- CreateIndex: "what happened to this record" / "who accessed this player"
CREATE INDEX "AuditEntry_account_id_target_ref_created_at_idx" ON "AuditEntry"("account_id", "target_ref", "created_at");

-- Carry over every PrivilegeAudit row through the action mapping (see libs/common/src/audit/legacy-mapping.ts,
-- which the same mapping is asserted total against).
--
-- `role_change -> role.assign` is a deliberate collapse: the old vocabulary had both, but a change IS an
-- assignment of the new role and the previous value was never recorded, so keeping two names would imply a
-- distinction the data cannot support.
--
-- `detail_json` carries over unchanged — it was already values-free (permission keys and scope only).
-- `actor_kind` defaults to 'user': every historical privilege change had a human actor.
INSERT INTO "AuditEntry" (
    "id", "account_id", "actor_user_id", "actor_kind", "actor_ref", "under_preview",
    "action", "target_ref", "detail_json", "created_at"
)
SELECT
    "id",
    "account_id",
    "actor_user_id",
    'user',
    NULL,
    false,
    CASE "action"
        WHEN 'role_assign'  THEN 'role.assign'
        WHEN 'role_change'  THEN 'role.assign'
        WHEN 'role_revoke'  THEN 'role.revoke'
        WHEN 'perm_grant'   THEN 'permission.grant'
        WHEN 'perm_revoke'  THEN 'permission.revoke'
        WHEN 'reset'        THEN 'permission.reset'
        -- An unmapped legacy value must NOT be silently dropped or renamed to something plausible: it is
        -- preserved with a marker so a reader can see the trail has a row nobody planned for, rather than
        -- the row vanishing.
        ELSE 'legacy.' || "action"
    END,
    "target_ref",
    "detail_json",
    "created_at"
FROM "PrivilegeAudit";

-- DropTable: only after the copy above committed.
DROP TABLE "PrivilegeAudit";
