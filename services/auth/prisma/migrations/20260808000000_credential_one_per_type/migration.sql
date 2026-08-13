-- MVP block W1 (roadmap 1.7) — one credential per type per person.
--
-- FOUND BY A LIVE RUN, not by review. Seeding real password hashes surfaced a user with TWO password
-- credentials: `tb024-cred-agent1` (hand-made during feature 024's live round) and the seed's own row.
-- `LoginService` reads the password with `findFirst({ user_id, type: 'password' })` and NO ordering,
-- so with two rows the hash that gets verified is decided by Postgres row order — a correct password
-- can be refused, and a superseded one can keep working. The ambiguity is removed here rather than
-- patched with an ORDER BY, because then `findFirst` is deterministic by construction and no future
-- reader has to know why the ordering matters.
--
-- ⚠️ DUPLICATES ARE RESOLVED, NOT REPORTED, and the rule is stated rather than implied: for a
-- password, **the newest row wins** — a later hash supersedes an earlier one, which is what "changed
-- my password" means. Ties (identical `created_at`) fall back to `id` so the choice is total and the
-- same on every run.
--
-- This is safe here because the only data that exists is synthetic (Principle V: no real customer or
-- staff data has entered any environment yet). If this migration ever runs where real credentials
-- exist, the losing rows are superseded passwords — the person keeps the most recent one.

DELETE FROM "Credential" c
USING "Credential" newer
WHERE c."user_id" = newer."user_id"
  AND c."type" = newer."type"
  AND (
        c."created_at" < newer."created_at"
     OR (c."created_at" = newer."created_at" AND c."id" < newer."id")
  );

CREATE UNIQUE INDEX "Credential_user_id_type_key"
  ON "Credential" ("user_id", "type");
