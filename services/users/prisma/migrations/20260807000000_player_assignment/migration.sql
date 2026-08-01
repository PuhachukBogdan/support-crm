-- Feature 026 — player ↔ account-manager assignment (roadmap 5.7, scope brief §4A / ADR 0032 §4).
--
-- Hand-written, like every migration here, and therefore able to drift from schema.prisma. One
-- thing in this file exists ONLY here and nowhere else — the partial unique index below — so the
-- structural test reads this SQL rather than the schema.

CREATE TABLE "PlayerAssignment" (
    "id"         TEXT NOT NULL,
    "account_id" TEXT NOT NULL,

    -- The player, by the full identity feature 020 established. A bare player_id names two people.
    "brand_id"   TEXT NOT NULL,
    "player_id"  TEXT NOT NULL,

    -- The manager: an AUTH identity, not an operator profile id (research R1). The narrowing asks
    -- "is the CALLER attached to this player?" on every masked read, and the caller is an auth
    -- identity — anything else would put a translation on the hottest read path in the product.
    "am_auth_user_id" TEXT NOT NULL,

    -- WHO DECIDED. Not the same question as who looks after the player, even when the answer is the
    -- same person — and the abnormal-volume signal is computed from this column precisely because
    -- the case that matters is somebody attaching many players to themselves.
    "assigned_by" TEXT NOT NULL,

    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- NULL = ACTIVE. Detaching closes a period; it never deletes one.
    "ended_at"   TIMESTAMP(3),
    "ended_by"   TEXT,

    CONSTRAINT "PlayerAssignment_pkey" PRIMARY KEY ("id")
);

-- ⭐ THE PARTIAL UNIQUE INDEX — the whole reason this migration is interesting.
--
-- 🅿 PROVISIONAL: one ACTIVE manager per player. The operator stated it as a leaning, not a lock.
--
-- Filtered to `ended_at IS NULL`, so two requirements that look opposed both hold: the database
-- refuses a second ACTIVE manager, while every closed period stays exactly where it was. An
-- unfiltered unique index would forbid a player from ever having had a second manager — the
-- opposite of additive history.
--
-- Widening to several managers later is `DROP INDEX`. A dropped constraint, not a reshape, and no
-- data moves. That is what makes "a leaning, not a lock" real rather than a comment.
CREATE UNIQUE INDEX "PlayerAssignment_one_active_am_per_player"
    ON "PlayerAssignment"("account_id", "brand_id", "player_id")
    WHERE "ended_at" IS NULL;

-- "Who looks after this player?" — the lookup the narrowing performs on every masked read.
CREATE INDEX "PlayerAssignment_account_id_brand_id_player_id_ended_at_idx"
    ON "PlayerAssignment"("account_id", "brand_id", "player_id", "ended_at");

-- "My players" — the 9.10 portfolio list, keyset-paged.
CREATE INDEX "PlayerAssignment_account_id_am_auth_user_id_ended_at_idx"
    ON "PlayerAssignment"("account_id", "am_auth_user_id", "ended_at");

-- "Who attached how many, and when?" — this index exists ONLY for the abnormal-volume question.
-- Without it the answer needs a scan, which is how a monitoring signal becomes something nobody runs.
CREATE INDEX "PlayerAssignment_account_id_assigned_by_started_at_idx"
    ON "PlayerAssignment"("account_id", "assigned_by", "started_at");
