-- CreateTable
CREATE TABLE "ContactViewAudit" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "field_category" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactViewAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactViewAudit_account_id_created_at_idx" ON "ContactViewAudit"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "ContactViewAudit_account_id_player_id_idx" ON "ContactViewAudit"("account_id", "player_id");

