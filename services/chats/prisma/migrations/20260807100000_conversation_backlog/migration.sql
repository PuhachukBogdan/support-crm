-- Feature 031 (roadmap 4.20, ADR 0042 §1) — the ONE ordered backlog.
--
-- Purely ADDITIVE: one nullable column and one index. No backfill: every existing conversation is
-- "not waiting", which is what NULL means, and that is the correct starting state — nothing was
-- queued before there was a queue.
--
-- ⚠️ The index is `(account_id, backlog_at)` and account-scoped leading, like every other list index
-- on this table: every read is confined to one account (Principle I), so the planner gets that first.
-- Without it the drain would sort over a scan of the largest table in the system to find one row.
--
-- ⓘ A partial index (`WHERE backlog_at IS NOT NULL`) would be smaller and is deliberately NOT used yet:
-- the backlog is expected to hold tens of rows against ~372K conversations, so the win is real but the
-- measurement is not in yet. Recorded so the next person tuning this finds the thought rather than
-- re-deriving it.

ALTER TABLE "Conversation" ADD COLUMN "backlog_at" TIMESTAMP(3);
CREATE INDEX "Conversation_account_id_backlog_at_idx" ON "Conversation"("account_id", "backlog_at");
