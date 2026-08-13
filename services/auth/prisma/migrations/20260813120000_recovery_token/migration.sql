-- W36 / feature 041 — password recovery (roadmap 3.18). Hand-written, like every migration here.
--
-- ⚠️ THIS IS A SECOND TOKEN TABLE ON PURPOSE, and the duplication is the security property.
--
-- `LoginCode` already stores an emailed one-time secret and reserves the word `recovery` in its
-- `purpose` column. That reservation is dead as of this migration, and the reason is written into the
-- schema: `VerifyLoginCode` MINTS A SESSION. A recovery secret living in that table would be one
-- forgotten `purpose` check away from being a password-free login. Roadmap 3.18 requires a token
-- «distinct from the login code», and a separate table makes it *inexpressible* to that verifier —
-- the difference between a rule that is policed and one that cannot be broken.
--
-- DDL only. No data statements.

CREATE TABLE "RecoveryToken" (
    "id"         TEXT NOT NULL,   -- public half of "<id>.<secret>"
    "account_id" TEXT NOT NULL,
    "user_id"    TEXT NOT NULL,

    -- argon2id hash of the secret. The clear value exists only inside the emailed link.
    "token_hash" TEXT NOT NULL,

    "expires_at" TIMESTAMP(3) NOT NULL,
    -- Wrong secrets against THIS token: at the cap the token is dead. A per-address limiter cannot
    -- express that, which is why the counter is on the row.
    "attempts"   INTEGER NOT NULL DEFAULT 0,
    -- Set when a password is actually set → single-use.
    "consumed_at" TIMESTAMP(3),
    -- Why it stopped being usable WITHOUT being consumed: 'superseded' or 'revoked'. A dead link must
    -- be able to say why; a deleted row answers "there was never one", which is the wrong answer to
    -- give a person holding one.
    "voided_at"    TIMESTAMP(3),
    "voided_cause" TEXT,

    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryToken_pkey" PRIMARY KEY ("id")
);

-- ⚠️ NO unique index on `user_id`. "One LIVE token per person" is enforced by the WRITE (issuing voids
-- the previous one), because the history is what lets the trail explain a dead link — the same
-- additive-history reasoning `PlayerAssignment`'s partial index records.

-- "Is this token live, and whose is it?" — the verify path's own lookup.
CREATE INDEX "RecoveryToken_user_id_idx" ON "RecoveryToken"("user_id");
-- The tenancy index every scoped table here carries.
CREATE INDEX "RecoveryToken_account_id_idx" ON "RecoveryToken"("account_id");
-- Expiry sweeps (retention, SEC-25/Q37, when it lands) read this.
CREATE INDEX "RecoveryToken_expires_at_idx" ON "RecoveryToken"("expires_at");

-- ⚠️ `Credential.last_rotated_at` needs no migration — the column has existed since Phase 3 with NO
-- WRITER. This feature is the first thing that sets it.
