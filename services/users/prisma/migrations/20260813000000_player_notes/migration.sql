-- W35 / feature 040 — player notes (R35 · U17, block W35 of cowork/mvp2-plan.md).
--
-- Hand-written, like every migration here. DDL ONLY: there is deliberately not one data statement in
-- this file, and that absence is a finding rather than an omission.
--
-- `Player.am_notes` — the single text column this table supersedes — has **no writer anywhere in the
-- product**. The permission key `users.am_notes.edit` was declared by feature 011 and has zero
-- enforcement points; no service, no route and no screen has ever written that column. So no real note
-- exists to carry over. Its one non-null value in the seed belongs to feature 020's brand-collision
-- fixture ("every field that differs here is a field the old single-column key would have silently
-- overwritten"), and copying THAT into a signed note would fabricate both an author and an intent.
--
-- The column is therefore left exactly where it is, superseded in the schema comment: it is a shipped
-- wire field (`Player.am_notes = 6`, guarded by `buf breaking`), and the fail-closed tier map requires
-- every column that exists to be classified.

CREATE TABLE "PlayerNote" (
    "id"         TEXT NOT NULL,
    "account_id" TEXT NOT NULL,

    -- The player by the full identity feature 020 established. A bare player_id names two customers.
    "brand_id"   TEXT NOT NULL,
    "player_id"  TEXT NOT NULL,

    "body" TEXT NOT NULL,

    -- WHO WROTE IT — an AUTH identity, the same one PlayerAssignment.am_auth_user_id stores, so
    -- "the author" and "the attached manager" are comparable without a translation step. ⚠️ NOT an
    -- Operator.id: W31 shipped a handover that moved nothing on exactly that confusion.
    "author_auth_user_id" TEXT NOT NULL,

    -- What the detector recognised WHEN THE AUTHOR WAS WARNED: a comma-joined subset of the closed
    -- vocabulary (email · handle · phone), empty for an ordinary note. A record of what was shown at
    -- the time, never a standing claim about the text.
    "pattern_kinds" TEXT NOT NULL DEFAULT '',

    -- Caller-supplied idempotence reference. Never derived from the body: two identical observations
    -- on different days are two facts.
    "client_ref" TEXT NOT NULL,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlayerNote_pkey" PRIMARY KEY ("id")
);

-- ⚠️ THERE IS NO `updated_at`, NO `revision` AND NO `deleted_at`, and that is the enforcement rather
-- than a simplification. Append-only is a promise the schema itself keeps: a table with no mutable
-- column has nothing an UPDATE could sensibly touch, so the guarantee does not depend on every future
-- caller remembering it. A correction is a new row.

-- A retried request is ONE row. Scoped to the account because that is what the reference means here.
CREATE UNIQUE INDEX "PlayerNote_account_id_client_ref_key"
    ON "PlayerNote"("account_id", "client_ref");

-- The only read there is: this player's notes, newest first.
CREATE INDEX "PlayerNote_account_id_brand_id_player_id_created_at_idx"
    ON "PlayerNote"("account_id", "brand_id", "player_id", "created_at");

-- The tenancy index every scoped table here carries.
CREATE INDEX "PlayerNote_account_id_idx" ON "PlayerNote"("account_id");
