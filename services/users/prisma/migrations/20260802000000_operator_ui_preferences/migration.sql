-- Feature 021 (roadmap 5.6 / ADR 0035 §7) — the OPERATOR's own appearance settings.
--
-- ⚠️ NOT the customer's preferences. `Player.preferences_json` is VIP portfolio data about a real
-- human being (tier `am_only`, masked from most roles). This table holds an employee's theme and font
-- size: cosmetic, self-owned, gated by no permission, containing no PII.
--
-- ONE ROW PER KEY rather than one JSON column. A blob would be the untyped bucket this feature exists
-- to prevent — validation would live only in the service while the database accepted anything. A row
-- per key gives the closed catalogue a physical counterpart, makes a partial write an upsert of exactly
-- the named keys (two tabs changing different settings cannot clobber each other, no locking), and
-- turns a retired catalogue key into a row the reader simply ignores.
--
-- `account_id` leads the key so the isolation predicate the feature-007 extension injects stays
-- index-aligned, and so a second licensee's operator cannot collide with the first's.
--
-- IDEMPOTENT: `IF NOT EXISTS` throughout. Feature 020's migration was not idempotent on its first
-- version and only a second run against a clone of the live database revealed it.

CREATE TABLE IF NOT EXISTS "OperatorUiPreference" (
    "account_id"   TEXT NOT NULL,
    "auth_user_id" TEXT NOT NULL,
    "key"          TEXT NOT NULL,
    "value"        TEXT NOT NULL,
    "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorUiPreference_pkey" PRIMARY KEY ("account_id", "auth_user_id", "key")
);

-- No secondary index, deliberately. Every access is by the (account_id, auth_user_id) prefix or by the
-- full key, and the primary-key index serves both. An index here would be cargo.
--
-- No foreign key either: `auth_user_id` is a soft reference to `auth.User.id`, which lives in a
-- DIFFERENT DATABASE (one database per service, Principle VIII). A constraint is not expressible and
-- a join is forbidden.
