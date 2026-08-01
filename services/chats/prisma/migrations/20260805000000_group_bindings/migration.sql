-- Feature 024 (roadmap 5.3, ADR 0039) — the two group bindings chats owns.
--
-- Purely ADDITIVE: two nullable columns and one index. No backfill, and no behaviour changes for a
-- single existing row — NULL means "not routed to a desk" and "not scoped to a desk", which is what
-- every conversation and every automation rule is today.

-- Which desk this conversation was routed to. Soft ref to auth.Group.id, never joined (Principle
-- VIII). Written by auto-assignment when the caller names a group; the caller-supplied candidate
-- path leaves it NULL, unchanged.
ALTER TABLE "Conversation" ADD COLUMN "routed_group_id" TEXT;

-- The rule applies only to work routed to that desk. A rule whose group has been deleted therefore
-- matches NOTHING, with no lookup and no cross-service call: a deleted group is never again the
-- routed group of anything. That closes the dangerous failure mode by construction — a scoped rule
-- must never silently become a rule that fires on everything.
ALTER TABLE "Automation" ADD COLUMN "scope_group_id" TEXT;

-- "Show me this desk's work" is a foreseeable list read, and this is a high-cardinality column on the
-- largest table in the system (Principle VII). No matching index on Automation.scope_group_id: the
-- engine's hot lookup is already (account_id, active) over a small set.
CREATE INDEX "Conversation_account_id_routed_group_id_idx" ON "Conversation"("account_id", "routed_group_id");
