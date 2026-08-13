-- Feature 031 (roadmap 4.19 / ADR 0042 §6) — the urgency RANK.
--
-- The Inbox shipped with two orders and refused a third, because nothing computed urgency and a sort
-- asserting a property the data lacks is wrong in a way nobody can see. This column is that property.
--
-- ⚠️ It holds the rank of the priority WORD and nothing about time. The other half of urgency — how long
-- a conversation has waited — is read from `updated_at` at query time, which is why no sweep has to keep
-- this value true and why it cannot be stale. See `src/conversation/urgency.ts`.
--
-- ⭐ BACKFILLED in the same statement block, deliberately. A default of 0 with no backfill would leave
-- every one of the ~372 K existing conversations unranked, so the new order would put the entire history
-- below anything created after this migration — a plausible-looking list that is wrong for months.
--
-- ⓘ Words not in the set (the column is free-form by design) and NULL both stay 0: "unranked" is its own
-- floor and is NOT the same as `normal`, because guessing `normal` promotes untriaged work above work
-- somebody deliberately marked `low`.
ALTER TABLE "Conversation" ADD COLUMN "priority_rank" INTEGER NOT NULL DEFAULT 0;

UPDATE "Conversation" SET "priority_rank" = CASE "priority"
  WHEN 'low' THEN 1
  WHEN 'normal' THEN 2
  WHEN 'high' THEN 3
  ELSE 0
END
WHERE "priority" IS NOT NULL;

-- `(priority_rank DESC, updated_at ASC, id)` is the order; the index is account-scoped leading like every
-- other list index here, because every read is confined to one account (Principle I).
CREATE INDEX "Conversation_account_id_priority_rank_updated_at_idx" ON "Conversation"("account_id", "priority_rank", "updated_at");
