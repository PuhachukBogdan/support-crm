-- Feature 014 (roadmap 4.6 automations + 4.7 first-reply SLA).
--
-- Additive only: the reserved "Automation" table (created empty by the 006 init migration and never
-- written by any code path) gains four columns; three new account-scoped tables are created. No
-- column is renamed or dropped and no existing index is altered — the same discipline the proto
-- follows.
--
-- Authored by hand (dev box has no DB; `chats_user` has no CREATEDB, so Track B applies this with
-- `prisma migrate deploy`, never `migrate dev`).
--
-- On "author_user_id": added NOT NULL via a transient DEFAULT '' that is then dropped, so the
-- migration cannot fail even against a non-empty table. An empty author is harmless because it is
-- fail-closed: no author resolves ⇒ the rule is REFUSED and never applied (FR-024).

-- AlterTable: Automation gains its author (the authority it acts with), ordering and revision.
ALTER TABLE "Automation" ADD COLUMN "author_user_id" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Automation" ALTER COLUMN "author_user_id" DROP DEFAULT;
ALTER TABLE "Automation" ADD COLUMN "author_brands" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Automation" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Automation" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "Automation_account_id_name_key" ON "Automation"("account_id", "name");

-- CreateIndex
CREATE INDEX "Automation_account_id_active_idx" ON "Automation"("account_id", "active");

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "automation_id" TEXT NOT NULL,
    "automation_revision" INTEGER NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FirstReplySlaPolicy" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "target_minutes" INTEGER NOT NULL,
    "scope_priority" TEXT NOT NULL DEFAULT '*',
    "scope_brand_id" TEXT NOT NULL DEFAULT '*',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FirstReplySlaPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationSlaState" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "target_minutes" INTEGER NOT NULL,
    "deadline_at" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT NOT NULL DEFAULT 'running',
    "first_reply_at" TIMESTAMP(3),
    "first_reply_seconds" INTEGER,
    "breach_announced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationSlaState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the at-most-once guarantee (FR-008 / research R6) — NOT an application check.
CREATE UNIQUE INDEX "AutomationRun_automation_id_conversation_id_event_key_key" ON "AutomationRun"("automation_id", "conversation_id", "event_key");

-- CreateIndex
CREATE INDEX "AutomationRun_account_id_automation_id_created_at_idx" ON "AutomationRun"("account_id", "automation_id", "created_at");

-- CreateIndex
CREATE INDEX "AutomationRun_account_id_conversation_id_idx" ON "AutomationRun"("account_id", "conversation_id");

-- CreateIndex: '*' sentinels make this constraint actually constrain (research R7 — NULLs would be
-- treated as distinct, allowing two account-level defaults).
CREATE UNIQUE INDEX "FirstReplySlaPolicy_account_id_scope_priority_scope_brand_id_key" ON "FirstReplySlaPolicy"("account_id", "scope_priority", "scope_brand_id");

-- CreateIndex
CREATE INDEX "FirstReplySlaPolicy_account_id_idx" ON "FirstReplySlaPolicy"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationSlaState_conversation_id_key" ON "ConversationSlaState"("conversation_id");

-- CreateIndex
CREATE INDEX "ConversationSlaState_account_id_outcome_idx" ON "ConversationSlaState"("account_id", "outcome");

-- CreateIndex: THE SWEEP PREDICATE (outcome='running' AND deadline_at <= now()) — deliberately
-- account-agnostic because a timer has no account context (research R2/R3). Read index only.
CREATE INDEX "ConversationSlaState_outcome_deadline_at_idx" ON "ConversationSlaState"("outcome", "deadline_at");
