-- MVP block W1 (roadmap 5.10) — one operator profile per person per account.
--
-- WHY THIS INDEX EXISTS AND NOT JUST THE SCHEMA LINE: `EnsureOwnOperator` upserts on this pair, and
-- it is called from two paths that can race — the tail of registration and the first login. An
-- upsert without a unique index is a read-then-write with a window in it, and what falls through the
-- window is a SECOND profile for one human being. Duplicate staff identities break accountability
-- (two authors for one person) and anti-pitching (two rows to attach players to), which is the same
-- hazard roadmap 3.16 writes out at length for re-hires.
--
-- ⚠️ IF THIS MIGRATION FAILS, IT HAS FOUND REAL DUPLICATES, and that is the migration doing its job
-- rather than a defect in it. Nothing in the product has ever created an `Operator` row — only the
-- seed and test fixtures — so duplicates would have to come from a hand-written INSERT on the stand.
-- Resolve by deciding which row is the person's profile (the one referenced by conversations'
-- `assignee_operator_id`) and removing the other; do NOT relax the constraint to make the migration
-- pass, because then the code above it is unsound.

CREATE UNIQUE INDEX "Operator_account_id_auth_user_id_key"
  ON "Operator" ("account_id", "auth_user_id");
