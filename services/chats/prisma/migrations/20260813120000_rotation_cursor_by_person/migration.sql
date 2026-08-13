-- ⭐ The rotation cursor names a PERSON, not a position (2026-08-13).
--
-- ⚠️ The old `cursor` was an index into the pool of operators who are available right now — a list
-- that changes length every time somebody logs on or off. An index into it points at a different
-- person after every such change, so one colleague is skipped and another receives two in a row,
-- with no error anywhere. An operator id is a rotation position that does not depend on who is
-- currently present. See services/chats/src/assignment/round-robin.ts.
--
-- The old value cannot be translated: an index only means something against the list it was taken
-- from, and that list no longer exists. Dropping it restarts each desk's rotation exactly once,
-- which is why this is done now rather than after the queues carry real work.
ALTER TABLE "RoundRobinState" ADD COLUMN "last_operator_id" TEXT;
ALTER TABLE "RoundRobinState" DROP COLUMN "cursor";
