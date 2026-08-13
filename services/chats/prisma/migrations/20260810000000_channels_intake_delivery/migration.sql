-- Feature 033 (roadmap 6.1/6.4/6.5/6.6, block W3) — channels: intake and delivery.
--
-- Four things happen here, and only ONE of them touches existing rows:
--   1. three new tables (Channel, ChannelIntake, OutboundMessage)
--   2. five new nullable columns (four on Conversation, one on Message) + their indexes
--   3. ⚠️ the ARRIVAL CHANNEL is typed IN PLACE — the only step that rewrites existing data
--   4. a unique index on Message.external_id, whose NULL semantics are the point
--
-- ⚠️ **NO `channel_kind` COLUMN IS CREATED.** `mvp-plan.md` and the spec name the concept `channel_kind`;
-- the column stays `channel` and its VALUES are rewritten, so the wire field is unchanged and every
-- reader downstream keeps working. Two columns for one fact would be two sources of truth, and the loser
-- is always whichever one the next reader did not notice.

-- ── 1. Channel — a configured way in and out, per (account, brand) ────────────────────────────────
--
-- No secret column: verifying an HMAC needs the key material, so a channel secret cannot be a hash the
-- way feature 028's invite token is. It lives in configuration (`CHANNEL_SECRETS`) keyed by `key`.
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "brand_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "address" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- The verification lookup: a delivery names a key, within an account.
CREATE UNIQUE INDEX "Channel_account_id_key_key" ON "Channel"("account_id", "key");
-- One channel per kind per brand — the MVP's "one key and one address" (2.1h). W15 will relax this
-- deliberately when a brand needs a second mailbox, rather than two rows silently competing for the
-- same inbound mail.
CREATE UNIQUE INDEX "Channel_account_id_brand_id_kind_key" ON "Channel"("account_id", "brand_id", "kind");
CREATE INDEX "Channel_account_id_idx" ON "Channel"("account_id");

-- ── 2. ChannelIntake — the at-most-once ledger ────────────────────────────────────────────────────
--
-- ⭐ `ChannelIntake_channel_id_external_event_id_key` IS the duplicate suppression. The write path
-- inserts first and reads a unique violation as "already accepted". A SELECT-then-INSERT would race the
-- provider's own retry, which arrives concurrently by design — the failure mode features 014 and 031
-- both shipped and had to repair on a live run.
CREATE TABLE "ChannelIntake" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "conversation_id" TEXT,
    "message_id" TEXT,
    "outcome" TEXT NOT NULL,
    "refusal_class" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelIntake_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelIntake_channel_id_external_event_id_key" ON "ChannelIntake"("channel_id", "external_event_id");
CREATE INDEX "ChannelIntake_account_id_created_at_idx" ON "ChannelIntake"("account_id", "created_at");

ALTER TABLE "ChannelIntake" ADD CONSTRAINT "ChannelIntake_channel_id_fkey"
    FOREIGN KEY ("channel_id") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 3. OutboundMessage — chats' own outbox ────────────────────────────────────────────────────────
--
-- Feature 028's mechanics, with its two gaps corrected: `next_attempt_at` gives the backoff FR-039
-- requires (028 retries on the very next tick), and there is NO recipient column — 028 stores and logs
-- the address, which is right for an operator's work address and wrong for a customer's.
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error_class" TEXT,
    "last_attempt_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundMessage_pkey" PRIMARY KEY ("id")
);

-- ⭐ One message, one delivery — structurally, not by the caller's care. A retry of the request that
-- posted the reply cannot produce a second copy for the customer.
CREATE UNIQUE INDEX "OutboundMessage_message_id_key" ON "OutboundMessage"("message_id");
-- The claim query, in its exact shape: pending rows whose backoff has elapsed, oldest first.
CREATE INDEX "OutboundMessage_status_next_attempt_at_idx" ON "OutboundMessage"("status", "next_attempt_at");
CREATE INDEX "OutboundMessage_account_id_idx" ON "OutboundMessage"("account_id");

-- ── 4. The five new columns ───────────────────────────────────────────────────────────────────────
--
-- All nullable, so no backfill is required and no existing row is rewritten by adding them.
ALTER TABLE "Conversation" ADD COLUMN "identity_state" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "channel_participant_id" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "continues_conversation_id" TEXT;
ALTER TABLE "Message" ADD COLUMN "external_id" TEXT;

-- W9's work queue: "show me the tickets nobody has been matched to".
CREATE INDEX "Conversation_account_id_identity_state_idx" ON "Conversation"("account_id", "identity_state");

-- ⚠️ This unique relies on Postgres treating NULLs as DISTINCT, which is the behaviour needed: every
-- non-email message has NULL and they must not collide. Asserted directly in
-- `tests/channels/constraints-033.spec.ts`, because a future `NULLS NOT DISTINCT` would turn "one copy
-- per inbound email" into "one message per account", silently.
CREATE UNIQUE INDEX "Message_account_id_external_id_key" ON "Message"("account_id", "external_id");

-- ── 5. ⚠️ THE ONE STEP THAT REWRITES EXISTING DATA: type the arrival channel ───────────────────────
--
-- Live values before this migration: 'chat', 'email', 'api', and NULL.
--
--   'email' → 'email'   unchanged
--   'api'   → 'api'     unchanged
--   'chat'  → 'api'     the widget chat IS the API channel (roadmap 6.1: "ingest external LLM-widget
--                       conversations as tickets"). One vocabulary, not two words for one transport.
--   NULL    → NULL      ⚠️ LEFT ALONE. NULL means *no arrival channel* — an agent-raised or seeded
--                       ticket — which is an ABSENCE, not a fourth kind. About one in six rows are NULL
--                       and the 029 Inbox filter depends on them staying reachable (see the `channel`
--                       filter note in conversation.repository.ts). Inventing an 'internal' kind to
--                       fill a legitimate absence would be a lie in the data.
UPDATE "Conversation" SET "channel" = 'api' WHERE "channel" = 'chat';

-- Anything else that may be in there — a hand-written INSERT, a value from a branch that never shipped —
-- is set to NULL rather than guessed at. A word the vocabulary cannot resolve is worse than no word: the
-- filter cannot offer it, the analytics split cannot bucket it, and `channelKindFromStored` returns the
-- `null` that means "this is a defect" instead of the `undefined` that means "there was no channel".
-- Making it NULL states the truth we actually have, which is that we no longer know how it arrived.
UPDATE "Conversation" SET "channel" = NULL
 WHERE "channel" IS NOT NULL AND "channel" NOT IN ('api', 'email', 'messenger');
