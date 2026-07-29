-- Feature 020 (roadmap 5.2 / ADR 0038 §3) — a player is identified by (account_id, brand_id, player_id).
--
-- WHY: GR8's `player_id` is unique only WITHIN a brand. The same value under brand A and brand B is
-- routinely TWO DIFFERENT PEOPLE. Using it as the whole primary key collapsed them into ONE ROW — one
-- card, one VIP flag, one set of AM notes — and the conversation feed then served one customer another's
-- messages. GR8's own contract corroborates it: `/players/find` answers with `brand` alongside `playerId`.
--
-- `account_id` leads the new key for two reasons: the isolation predicate the feature-007 extension
-- injects stays index-aligned, and two future licensees can both hold player `12345` (the same mistake
-- one layer up, dormant until multi-tenancy is real, fixed here because it is free now).
--
-- SAFETY: every step below either guards itself or aborts. This migration will only ever be exercised
-- against a friendly dataset (1 synthetic player at the time of writing), which is exactly why it is
-- written for the general case — a friendly dataset hides everything.

-- ── 1. The column, nullable for now ─────────────────────────────────────────────────────────────
ALTER TABLE "Player" ADD COLUMN IF NOT EXISTS "brand_id" TEXT;

-- ── 2 + 3. ABORT rather than guess, then derive ─────────────────────────────────────────────────
-- A player with zero brand edges has no brand to derive; a player with several is a row that already
-- represented more than one person. Neither can be resolved by picking one, and picking one is exactly
-- the class of decision this whole feature exists to remove.
--
-- ⚠️ The whole block is conditional on `PlayerBrand` still existing. Without that condition a SECOND
-- run fails with `relation "PlayerBrand" does not exist` — found by actually running this migration
-- twice against a clone of the live database rather than by reading it. FR-006 asks for idempotence,
-- and the guard that checks the data was itself the thing that could not run twice.
DO $$
DECLARE ambiguous_count INTEGER;
BEGIN
  IF to_regclass('"PlayerBrand"') IS NULL THEN
    RAISE NOTICE 'feature 020: PlayerBrand already removed — brands were derived by an earlier run';
    RETURN;
  END IF;

  SELECT count(*) INTO ambiguous_count FROM (
    SELECT p."player_id"
    FROM "Player" p
    LEFT JOIN "PlayerBrand" pb ON pb."player_id" = p."player_id"
    WHERE p."brand_id" IS NULL
    GROUP BY p."player_id"
    HAVING count(pb."brand_id") <> 1
  ) AS ambiguous;

  IF ambiguous_count > 0 THEN
    -- The COUNT is reported, never the ids: a player id identifies a customer (SEC-26).
    RAISE EXCEPTION
      'feature 020 migration aborted: % player row(s) have zero or several brand edges, so the brand cannot be derived without guessing. Resolve them by hand, then re-run.',
      ambiguous_count;
  END IF;

  UPDATE "Player" p
  SET "brand_id" = pb."brand_id"
  FROM "PlayerBrand" pb
  WHERE pb."player_id" = p."player_id"
    AND p."brand_id" IS NULL;
END $$;

ALTER TABLE "Player" ALTER COLUMN "brand_id" SET NOT NULL;

-- ── 4. Drop the edge BEFORE the key swap ────────────────────────────────────────────────────────
-- Its foreign key references the old primary key, so the key cannot be replaced while it stands.
-- With brand in the key, one row IS one brand's player and a many-to-many edge can no longer state
-- anything true. "This human exists on several brands" moves to Person/PersonMember below, where it
-- is a statement about a PERSON established from a matching email or phone.
DROP TABLE IF EXISTS "PlayerBrand";

-- ── 5. The key itself ───────────────────────────────────────────────────────────────────────────
-- Conditional for the same reason as the block above: on a second run the key is already the triple,
-- and dropping/re-adding it unconditionally would fail (or, worse, briefly leave the table without a
-- primary key). Only replace it when it is still the old single-column key.
DO $$
DECLARE current_key TEXT;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY k.ord) INTO current_key
  FROM pg_constraint c
  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE c.conrelid = '"Player"'::regclass AND c.contype = 'p';

  IF current_key IS DISTINCT FROM 'account_id,brand_id,player_id' THEN
    ALTER TABLE "Player" DROP CONSTRAINT IF EXISTS "Player_pkey";
    ALTER TABLE "Player" ADD CONSTRAINT "Player_pkey" PRIMARY KEY ("account_id", "brand_id", "player_id");
  END IF;
END $$;

-- ── 6. The keyset index follows the key ─────────────────────────────────────────────────────────
-- The brand list is now a direct predicate on this table (the edge it used to resolve through is gone),
-- so one index must serve the account predicate, the brand filter, the sort and the tie-break.
DROP INDEX IF EXISTS "Player_account_id_created_at_player_id_idx";
CREATE INDEX IF NOT EXISTS "Player_account_id_brand_id_created_at_player_id_idx"
  ON "Player"("account_id", "brand_id", "created_at", "player_id");

-- ── 7. The contact-match projection ─────────────────────────────────────────────────────────────
-- Stores a SALTED HASH of a normalised email/phone and never the value. A plaintext column would be a
-- new PII surface outside the opaque GR8 snapshot: unclassified by the tier policy, uncovered by
-- masking, unknown to exports, reachable by a log. A hash matches equality just as well and is useless
-- if read. Populated by the GR8 connector at roadmap 7.4; seeded directly in tests until then.
CREATE TABLE IF NOT EXISTS "ContactMatch" (
  "account_id" TEXT NOT NULL,
  "brand_id"   TEXT NOT NULL,
  "player_id"  TEXT NOT NULL,
  "kind"       TEXT NOT NULL,
  "value_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContactMatch_pkey" PRIMARY KEY ("account_id", "brand_id", "player_id", "kind")
);

ALTER TABLE "ContactMatch" DROP CONSTRAINT IF EXISTS "ContactMatch_player_fkey";
ALTER TABLE "ContactMatch"
  ADD CONSTRAINT "ContactMatch_player_fkey"
  FOREIGN KEY ("account_id", "brand_id", "player_id")
  REFERENCES "Player"("account_id", "brand_id", "player_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The matcher's only lookup: "who else carries this hash, within this account". Account leads so the
-- isolation predicate stays index-aligned and a match can never be found across tenants.
CREATE INDEX IF NOT EXISTS "ContactMatch_account_id_value_hash_idx"
  ON "ContactMatch"("account_id", "value_hash");

-- ── 8. A human spanning brands ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "Person" (
  "id"         TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Person_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Person_account_id_idx" ON "Person"("account_id");

-- `linked_on` records WHICH KIND of identifier established the link ('email' | 'phone') and never the
-- value. A link copies no data between members — that is what makes an automatic decision correctable.
CREATE TABLE IF NOT EXISTS "PersonMember" (
  "person_id"  TEXT NOT NULL,
  "account_id" TEXT NOT NULL,
  "brand_id"   TEXT NOT NULL,
  "player_id"  TEXT NOT NULL,
  "linked_on"  TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- account_id LEADS: the isolation extension injects an account predicate into every query here,
  -- and a composite index that does not lead with it cannot serve that predicate (Principle VII).
  CONSTRAINT "PersonMember_pkey" PRIMARY KEY ("account_id", "person_id", "brand_id", "player_id")
);

ALTER TABLE "PersonMember" DROP CONSTRAINT IF EXISTS "PersonMember_person_fkey";
ALTER TABLE "PersonMember"
  ADD CONSTRAINT "PersonMember_person_fkey"
  FOREIGN KEY ("person_id") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PersonMember" DROP CONSTRAINT IF EXISTS "PersonMember_player_fkey";
ALTER TABLE "PersonMember"
  ADD CONSTRAINT "PersonMember_player_fkey"
  FOREIGN KEY ("account_id", "brand_id", "player_id")
  REFERENCES "Player"("account_id", "brand_id", "player_id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- A player record belongs to at most ONE person — enforced by the database rather than by a service
-- remembering to check before it links.
CREATE UNIQUE INDEX IF NOT EXISTS "PersonMember_account_id_brand_id_player_id_key"
  ON "PersonMember"("account_id", "brand_id", "player_id");
CREATE INDEX IF NOT EXISTS "PersonMember_account_id_idx" ON "PersonMember"("account_id");
