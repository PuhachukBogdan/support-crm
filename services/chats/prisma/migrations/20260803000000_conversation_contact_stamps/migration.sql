-- Feature 022 (roadmap 4.13) — the player card's contact facts move onto the conversation row.
--
-- WHY THESE COLUMNS EXIST. The card must say "when did we last talk to this customer". The value that
-- already looks like that is `Conversation.updated_at`, and it is a Prisma `@updatedAt` column: any
-- edit bumps it — a label, a reassignment, a resolve. A card built on it reports our own internal work
-- as customer contact and looks entirely right doing so. So the fact is derived from MESSAGES.
--
-- WHY MAINTAINED RATHER THAN AGGREGATED AT READ TIME (research R1). `Message` is indexed on
-- `(conversation_id, created_at)` and `(account_id)`; nothing indexes `author_type`. A read-time
-- aggregate would therefore visit every message of every conversation of that customer, on the
-- critical path of every card open, growing with their whole history. With these two columns the
-- entire summary — overall maxima, per-channel rollup, per-status counts — is ONE grouped query over
-- conversations the customer already owns, and no message row is read at all.
--
-- NULLABLE IS MEANINGFUL: NULL = "this never happened in this conversation". A conversation whose only
-- message is a private note has both columns NULL and is still counted. It must never be rendered as
-- an epoch date.
--
-- NO INDEX on either column, deliberately: they are projected and aggregated, never filtered on.
ALTER TABLE "Conversation"
  ADD COLUMN "last_inbound_at"  TIMESTAMP(3),
  ADD COLUMN "last_outbound_at" TIMESTAMP(3);

-- BACKFILL, and it is part of the migration rather than a script someone remembers to run.
--
-- A shipped column that is NULL for every historical row would make the card report "never contacted"
-- for the ENTIRE existing history — the exact wrong answer this feature exists to prevent, delivered
-- at the moment of release.
--
-- The two FILTER predicates ARE the derivation rule in `services/chats/src/message/contact-stamp.ts`:
--   player                        -> last_inbound_at
--   operator AND private = false  -> last_outbound_at
--   operator AND private = true   -> nothing (a private note is not contact — SEC-13 / roadmap 4.7)
--   system                        -> nothing (machine output is not a conversation)
-- `services/chats/tests/migration-022.spec.ts` compares these clauses against that module textually,
-- so changing the rule in code without changing it here fails a test instead of corrupting data.
UPDATE "Conversation" c SET
  "last_inbound_at"  = m."last_inbound_at",
  "last_outbound_at" = m."last_outbound_at"
FROM (
  SELECT "conversation_id",
         MAX("created_at") FILTER (WHERE "author_type" = 'player')                              AS "last_inbound_at",
         MAX("created_at") FILTER (WHERE "author_type" = 'operator' AND "private" = false)      AS "last_outbound_at"
  FROM "Message"
  GROUP BY "conversation_id"
) m
WHERE c."id" = m."conversation_id";
