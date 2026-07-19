import { parseSchema, getField } from './schema-scan';

/**
 * T5 / SC-004 / FR-015, FR-017 (ADR 0032 §0.1 "Player-lite"): a Player is ONE record keyed by
 * `player_id`, unified across 1..N brands via the `PlayerBrand` edge, holding our own fields +
 * an OPAQUE GR8-cache seam (`gr8_snapshot` + `gr8_fetched_at` + `gr8_stale`) and NO other
 * GR8-named field (GR8's typed projection is deferred to 7.4 — we don't own its schema).
 * Fails on the US2 skeleton (no PlayerBrand / no GR8 seam).
 */
describe('Player-lite entity + opaque GR8 seam (ADR 0032)', () => {
  const users = () => parseSchema('users');
  const player = () => users().find((m) => m.name === 'Player')!;
  const playerBrand = () => users().find((m) => m.name === 'PlayerBrand');

  it('Player is keyed by player_id (domain key, not a uuid)', () => {
    const idIndex = player().indexes.find((i) => i.kind === 'id');
    expect(idIndex?.columns).toEqual(['player_id']);
  });

  it('the brand-union edge PlayerBrand exists as a join table', () => {
    const pb = playerBrand();
    expect(pb).toBeDefined();
    expect(pb!.isJoinTable).toBe(true);
    // Composite key of (player_id, brand_id) — supports 1..N brands per player.
    const idIndex = pb!.indexes.find((i) => i.kind === 'id');
    expect(idIndex?.columns).toEqual(['player_id', 'brand_id']);
  });

  it('reserves EXACTLY the three opaque GR8 seam columns and no other GR8 field', () => {
    const gr8Fields = player()
      .fields.map((f) => f.name)
      .filter((n) => /gr8/i.test(n));
    expect(gr8Fields.sort()).toEqual(['gr8_fetched_at', 'gr8_snapshot', 'gr8_stale']);
  });

  it('the GR8 snapshot is an opaque, nullable JSON blob (unpopulated defaults to stale)', () => {
    const snapshot = getField(player(), 'gr8_snapshot');
    expect(snapshot?.baseType).toBe('Json');
    expect(snapshot?.optional).toBe(true);
    const stale = getField(player(), 'gr8_stale');
    expect(stale?.baseType).toBe('Boolean');
    expect(stale?.attributes).toMatch(/@default\(true\)/);
  });

  it('holds our own AM-owned fields (am_notes, preferences, portfolio)', () => {
    for (const f of ['am_notes', 'preferences', 'portfolio']) {
      expect(getField(player(), f)).toBeDefined();
    }
  });
});
