-- ⭐ W31 / feature 038 (ADR 0043 §4, SEC-PV2): the offboarding handover reads «all open work of ONE
-- operator». Every existing index leads with (account_id, something-else), so that question is a
-- scan today — and it is asked while a person is being offboarded and somebody is waiting.
CREATE INDEX "Conversation_account_id_assignee_operator_id_idx"
  ON "Conversation"("account_id", "assignee_operator_id");
