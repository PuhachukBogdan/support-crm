-- Feature 033 (roadmap 6.4) — the envelope a channel conversation must be answered at.
--
-- ⚠️ This table holds the ONE new clear-text contact value the channels feature adds, and it is in THIS
-- database because this service already owns contact values: it holds `CONTACT_HASH_SALT`, it holds the
-- opaque GR8 snapshot, and it is the only service with a field-tier allow-list. A column on
-- `chats.Conversation` would have created what `ContactMatch`'s own comment warns about — a PII surface
-- the tier policy does not classify, masking does not cover, exports do not know about, and a log could
-- reach. chats stores an opaque handle to a row here.
--
-- `address` is classified `masked_pii` in `libs/common/src/policy/field-tiers.ts`. That classification is
-- load-bearing rather than decorative: `allowedFields` filters that map, so an UNCLASSIFIED field is
-- served to nobody at all — fail-closed, but also outside the policy rather than inside its strictest
-- tier.
CREATE TABLE "ChannelParticipant" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "brand_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "player_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelParticipant_pkey" PRIMARY KEY ("id")
);

-- One participant per address per brand: a returning customer reuses the row instead of accumulating one
-- per conversation. Brand-scoped because identity is (ADR 0038) — the same address under two brands is two
-- participants until a `Person` link says otherwise.
CREATE UNIQUE INDEX "ChannelParticipant_account_id_brand_id_kind_address_key"
    ON "ChannelParticipant"("account_id", "brand_id", "kind", "address");
CREATE INDEX "ChannelParticipant_account_id_idx" ON "ChannelParticipant"("account_id");

-- Principle VII (`tests/data-model/indexes.spec.ts`): `player_id` is a high-cardinality soft ref, and
-- "which threads belong to this player" is the read W9's attach screen and the player card will both make.
-- Indexed before either exists — cheap now, a table scan on the day somebody writes the query.
CREATE INDEX "ChannelParticipant_account_id_player_id_idx" ON "ChannelParticipant"("account_id", "player_id");
