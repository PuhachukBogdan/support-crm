-- MVP block W5 (subpoint 2.4) — routing to the edge: a channel ticket reaches a specific agent.
--
-- Two additive pieces, no existing row is touched:
--   1. Channel.default_group_id — WHERE a channel's new tickets are pushed. NULL = not push-routed
--      (an honest absence, same reasoning as auth's Group.routable defaulting to false).
--   2. ConversationReadMark — the fact "this operator OPENED this conversation", which the agent
--      rail (roadmap 4.19) is a view over: assigned-to-me ∧ opened-by-me ∧ non-terminal category.
--      Written once per (conversation, operator); `last_read_at` advances on re-reads and is the
--      half 9.12's unread badge will stand on.

-- ── 1. The desk a channel pushes to ───────────────────────────────────────────────────────────────
ALTER TABLE "Channel" ADD COLUMN "default_group_id" TEXT;

-- ── 2. One operator read one conversation ─────────────────────────────────────────────────────────
CREATE TABLE "ConversationReadMark" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "first_opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationReadMark_pkey" PRIMARY KEY ("id")
);

-- One mark per reader per conversation — the upsert key; a re-read is idempotent by constraint,
-- not by application bookkeeping (the same at-most-once idiom as ChannelIntake).
CREATE UNIQUE INDEX "ConversationReadMark_account_id_conversation_id_operator_id_key"
    ON "ConversationReadMark"("account_id", "conversation_id", "operator_id");

-- The rail's own lookup: "which conversations has THIS operator opened".
CREATE INDEX "ConversationReadMark_account_id_operator_id_idx"
    ON "ConversationReadMark"("account_id", "operator_id");

-- The relation the rail's EXISTS predicate stands on. Cascade mirrors Message's: a mark without its
-- conversation is meaningless.
ALTER TABLE "ConversationReadMark" ADD CONSTRAINT "ConversationReadMark_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
