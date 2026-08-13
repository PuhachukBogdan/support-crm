-- W27 / feature 036 (roadmap 9.16): the shelf — the third place a conversation can be.
-- Additive, no backfill: NULL is the correct value for every existing row (ordinary).
ALTER TABLE "Conversation" ADD COLUMN "shelved_state" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "shelved_at" TIMESTAMP(3);
ALTER TABLE "Conversation" ADD COLUMN "shelved_by" TEXT;

-- Partial: serves only the two bucket lists. The common path filters `shelved_state IS NULL`,
-- which is ~every row and rides the existing (account_id, …) indexes instead.
CREATE INDEX "Conversation_account_id_shelved_state_shelved_at_idx"
  ON "Conversation"("account_id", "shelved_state", "shelved_at")
  WHERE "shelved_state" IS NOT NULL;
