-- Feature 015 (roadmap 4.8): the chats source of the federated audit trail.
--
-- Nothing to migrate here — chats had no audit store. Its first writer is `automation.delete` (the
-- feature-014 rule delete), which is a genuinely sensitive act: removing a rule that acts by itself.
--
-- The table is deliberately IDENTICAL to the ones in auth_db and users_db. It cannot be shared (one
-- database per service, Principle VIII) and the entry must sit in the transaction of the action it
-- describes, so `tests/data-model/audit-entry-identity.spec.ts` is what keeps the three copies from
-- drifting apart.
--
-- Applied on Track B with `prisma migrate deploy --schema services/chats/prisma/schema.prisma`.

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
