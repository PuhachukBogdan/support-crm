-- MVP block W24 (R43) — the ticket NUMBER becomes real.
--
-- `Conversation.reference` has been a reserved column since the schema was born: projected on the
-- wire, rendered in the ticket header, written by NOTHING (every row on every stand is NULL). The
-- operator's R43 asks for `[1043] Тема` as one field — so the number gains a writer, a backfill,
-- and a per-account uniqueness constraint.
--
--   1. ConversationReferenceCounter — `last` = the last ASSIGNED number per account. Incremented
--      atomically inside the create transaction; per-account rather than a global sequence so one
--      tenant's ticket volume never shows in another's gaps (Principle I).
--   2. Backfill: existing conversations are numbered per account in `created_at, id` order — the
--      order a human would have issued them in. Only NULL references are touched (defensive: none
--      are non-NULL anywhere today, but the migration must not renumber if that ever changes).
--   3. Counters are seeded to each account's highest assigned number, so the next created ticket
--      continues the sequence instead of colliding.
--   4. The per-account uniqueness becomes a CONSTRAINT — the UI claims it in every list row.

-- ── 1. The counter ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ConversationReferenceCounter" (
    "account_id" TEXT NOT NULL,
    "last" INTEGER NOT NULL,

    CONSTRAINT "ConversationReferenceCounter_pkey" PRIMARY KEY ("account_id")
);

-- ── 2. Number what already exists, oldest first ───────────────────────────────────────────────────
WITH numbered AS (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at, id) AS rn
    FROM "Conversation"
    WHERE reference IS NULL
)
UPDATE "Conversation" c
SET reference = numbered.rn::text
FROM numbered
WHERE c.id = numbered.id;

-- ── 3. Each account's counter starts where its backfill ended ─────────────────────────────────────
-- `reference ~ '^\d+$'` guards the cast: only numbers we (or this migration) issued count; a legacy
-- free-text reference (none exist, but the cast would abort the migration) is simply not a number.
INSERT INTO "ConversationReferenceCounter" (account_id, last)
SELECT account_id, MAX(reference::int)
FROM "Conversation"
WHERE reference ~ '^\d+$'
GROUP BY account_id;

-- ── 4. Two tickets of one account can never share a number ───────────────────────────────────────
CREATE UNIQUE INDEX "Conversation_account_id_reference_key" ON "Conversation"("account_id", "reference");
