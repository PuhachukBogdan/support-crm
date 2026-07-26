-- Feature 015 (roadmap 4.8): the general audit trail replaces the feature-011 contact-view trail.
--
-- `ContactViewAudit` has no live caller yet — the player-read gRPC handlers that would call it are Phase 5
-- — so this is a reshape rather than a data move. The rows are still copied first anyway: "expected empty"
-- is not "verified empty", and a migration that drops a table it assumed was empty is exactly the kind of
-- assumption that is only wrong once.
--
-- Applied on Track B with `prisma migrate deploy --schema services/users/prisma/schema.prisma`.

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

-- CreateIndex
CREATE INDEX "AuditEntry_account_id_created_at_id_idx" ON "AuditEntry"("account_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "AuditEntry_account_id_actor_user_id_created_at_idx" ON "AuditEntry"("account_id", "actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "AuditEntry_account_id_target_ref_created_at_idx" ON "AuditEntry"("account_id", "target_ref", "created_at");

-- Carry over any contact-view rows. The tier moves into `detail_json.tier`, which is the same discipline
-- the old table already had: the TIER name is recorded, never the field value.
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
    'contact.reveal',
    "player_id",
    jsonb_build_object('tier', "field_category"),
    "created_at"
FROM "ContactViewAudit";

-- DropTable: only after the copy above committed.
DROP TABLE "ContactViewAudit";
