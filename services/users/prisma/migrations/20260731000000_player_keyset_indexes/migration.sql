-- Feature 018 (roadmap 5.1) — INDEXES ONLY. No table, no column: everything this feature reads was
-- created at roadmap 2.2/2.7, which is the observable form of "these three RPCs were declared and
-- never served" — the data was ready and the surface was not.

-- The keyset page for ListPlayersByBrand. ONE index serving three jobs: the `account_id` predicate the
-- feature-007 isolation extension injects, the `(created_at, player_id)` sort, and the tie-break that
-- keeps a record from being skipped when several share an instant. Without it the query filters on an
-- index and then sorts — fine at seed scale, not a shape to ship (Principle VII).
CREATE INDEX "Player_account_id_created_at_player_id_idx" ON "Player"("account_id", "created_at", "player_id");

-- The existing `brand_id`-only index can FILTER but not ORDER. The brand list resolves through this
-- edge and pages on the parent, so the edge lookup wants the pair.
CREATE INDEX "PlayerBrand_brand_id_player_id_idx" ON "PlayerBrand"("brand_id", "player_id");
