-- Feature 013 (roadmap 4.4 + 4.5): conversation workflow.
-- Two new account-scoped tables. Nothing existing is altered — assignment reuses
-- Conversation.assignee_operator_id, and labels/macros reuse the 006 entities.
-- Authored by hand (dev box has no DB; `chats_user` has no CREATEDB so Track B applies this
-- with `prisma migrate deploy`, never `migrate dev`).

-- CreateTable
CREATE TABLE "CannedResponse" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CannedResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RoundRobinState" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "group_key" TEXT NOT NULL,
    "cursor" INTEGER NOT NULL DEFAULT -1,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RoundRobinState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CannedResponse_account_id_name_key" ON "CannedResponse"("account_id", "name");

-- CreateIndex
CREATE INDEX "CannedResponse_account_id_idx" ON "CannedResponse"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "RoundRobinState_account_id_group_key_key" ON "RoundRobinState"("account_id", "group_key");

-- CreateIndex
CREATE INDEX "RoundRobinState_account_id_idx" ON "RoundRobinState"("account_id");
