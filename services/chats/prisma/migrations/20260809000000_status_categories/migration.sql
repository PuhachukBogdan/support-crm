-- Feature 032 (roadmap 4.16, ADR 0040) — statuses become per-account CONFIGURATION under a closed
-- catalogue of six CATEGORIES.
--
-- ⚠️ THE ORDER OF THE FIVE STEPS IS THE MIGRATION. The foreign key cannot be added while a single
-- conversation still holds a word no account has configured, so every remap happens before it. And the
-- remap must include the two JSON columns: a stored macro that still names `CONVERSATION_STATUS_PENDING`
-- would fail at APPLY time, on a customer's conversation, rather than here where somebody is watching.
--
-- Seed set and legacy map: `libs/common/src/statuses/seed-set.ts` (one definition, three consumers —
-- this file, the seed, and the tests that assert both).

-- ── 1. The catalogue table ───────────────────────────────────────────────────────────────────────
CREATE TABLE "ConversationStatus" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL,
    "end_user_name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationStatus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConversationStatus_account_id_key_key" ON "ConversationStatus"("account_id", "key");
CREATE INDEX "ConversationStatus_account_id_active_order_idx" ON "ConversationStatus"("account_id", "active", "order");

-- ── 2. The nine statuses, for every account this database already knows about ─────────────────────
--
-- The account list is the UNION of the three tables that can name one, not just `Conversation`: an
-- account whose macros exist but whose first ticket has not arrived must still have a vocabulary, or the
-- rule it authored cannot be validated.
INSERT INTO "ConversationStatus" ("id", "account_id", "key", "category", "agent_name", "end_user_name", "order", "updated_at")
SELECT
    md5(a.account_id || ':' || s.key)::uuid::text,
    a.account_id,
    s.key,
    s.category,
    s.agent_name,
    s.end_user_name,
    s.order,
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT "account_id" FROM "Conversation"
    UNION SELECT DISTINCT "account_id" FROM "Macro"
    UNION SELECT DISTINCT "account_id" FROM "Automation"
) AS a
CROSS JOIN (
    VALUES
        ('new',               'new',      'New',                              'Open',                 10),
        ('open',              'open',     'Open',                             'Open',                 20),
        ('pending',           'pending',  'Pending',                          'Awaiting your reply',  30),
        ('vip_pending',       'pending',  'VIP Pending',                      'VIP Pending',          40),
        ('in_progress',       'on_hold',  'In progress',                      'Open',                 50),
        ('follow_up',         'on_hold',  'Follow-up',                        'Open',                 60),
        ('auto_ended_chat',   'on_hold',  'Auto-Ended Chat',                  'Open',                 70),
        ('supervisor_review', 'on_hold',  'Supervisor Review – In Progress',  'Open',                 80),
        ('solved',            'solved',   'Solved',                           'Solved',               90)
) AS s(key, category, agent_name, end_user_name, "order")
ON CONFLICT ("account_id", "key") DO NOTHING;

-- ── 3. The shipped vocabulary → the seeded keys (ADR 0040 §5) ────────────────────────────────────
--
-- `open` and `pending` keep their spelling and are deliberately not listed: an UPDATE that changes
-- nothing is an UPDATE somebody has to read twice. `snoozed → pending` is the one that loses a word,
-- and it loses nothing real — it came from the Chatwoot blueprint and never had a distinct meaning here.
UPDATE "Conversation" SET "status" = 'solved'  WHERE "status" = 'resolved';
UPDATE "Conversation" SET "status" = 'pending' WHERE "status" = 'snoozed';

-- Anything else — a value no release of this product ever wrote — lands on `open` rather than blocking
-- the deployment. Fail-closed would mean refusing to start with a database that cannot be corrected
-- without a hand-written UPDATE; `open` is the state a ticket in an unknown status actually needs.
UPDATE "Conversation" SET "status" = 'open'
WHERE "status" NOT IN ('new', 'open', 'pending', 'vip_pending', 'in_progress', 'follow_up', 'auto_ended_chat', 'supervisor_review', 'solved');

-- ── 4. The two JSON columns: a stored rule must not name a vocabulary that no longer exists ──────
--
-- `MACRO_ACTION_TYPE_SET_STATUS` values and `CONDITION_FIELD_STATUS` comparands both hold the proto ENUM
-- NAME. Rewritten as text and cast back, which is exact here because these four tokens cannot occur in
-- any other position of the document — they are not label ids, names or bodies.
UPDATE "Macro"
SET "definition" = replace(replace(replace(replace("definition"::text,
        'CONVERSATION_STATUS_RESOLVED', 'solved'),
        'CONVERSATION_STATUS_SNOOZED',  'pending'),
        'CONVERSATION_STATUS_PENDING',  'pending'),
        'CONVERSATION_STATUS_OPEN',     'open')::jsonb
WHERE "definition"::text LIKE '%CONVERSATION_STATUS_%';

UPDATE "Automation"
SET "definition" = replace(replace(replace(replace("definition"::text,
        'CONVERSATION_STATUS_RESOLVED', 'solved'),
        'CONVERSATION_STATUS_SNOOZED',  'pending'),
        'CONVERSATION_STATUS_PENDING',  'pending'),
        'CONVERSATION_STATUS_OPEN',     'open')::jsonb
WHERE "definition"::text LIKE '%CONVERSATION_STATUS_%';

-- ── 5. The constraint that makes "no unmapped row" structural rather than a claim ─────────────────
--
-- ON UPDATE CASCADE so renaming a key later is one statement rather than a rewrite of history;
-- ON DELETE RESTRICT because a status in use must not be removable — retirement is `active = false`.
ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_account_id_status_fkey"
    FOREIGN KEY ("account_id", "status")
    REFERENCES "ConversationStatus"("account_id", "key")
    ON DELETE RESTRICT ON UPDATE CASCADE;
