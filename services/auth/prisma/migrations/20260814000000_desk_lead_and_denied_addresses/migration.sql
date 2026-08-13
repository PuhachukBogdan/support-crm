-- ⭐ W32 (roadmap 3.16 + 12.10).
--
-- 1) `Group.lead_user_id` — who answers for a desk. Nullable on purpose: a desk without a lead is a
--    legitimate state with a named outcome in the offboarding sweep, and there is no default person
--    that would not hand somebody work they never agreed to answer for.
--    ⚠️ Every existing desk starts with NO lead. That is deliberate and visible: until an
--    administrator names one, a departing colleague's personal conversations keep going to the queue
--    exactly as they did before this feature — the safety net, unchanged — and the count of those
--    cases appears on the security page as something to fix.
ALTER TABLE "Group" ADD COLUMN "lead_user_id" TEXT;
CREATE INDEX "Group_account_id_lead_user_id_idx" ON "Group"("account_id", "lead_user_id");

-- 2) `DeniedAddress` — the deny-list. Per account in storage (trail, screen, isolation); the boundary
--    checks the union, because an unauthenticated request has no account to scope by. See the model's
--    own comment for why those two facts cannot both be satisfied by a per-account check.
CREATE TABLE "DeniedAddress" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeniedAddress_pkey" PRIMARY KEY ("id")
);

-- The uniqueness is the idempotence: a repeated ban is the same intent, not a second row.
CREATE UNIQUE INDEX "DeniedAddress_account_id_address_key" ON "DeniedAddress"("account_id", "address");
CREATE INDEX "DeniedAddress_account_id_idx" ON "DeniedAddress"("account_id");
