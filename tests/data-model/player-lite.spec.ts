import { parseSchema, getField } from './schema-scan';

/**
 * T5 / SC-004 / FR-015, FR-017 — the Player entity and its opaque GR8-cache seam.
 *
 * ⚠️ **The identity half of this spec was rewritten by feature 020 (ADR 0038 §3).** It used to assert
 * ADR 0032 §0.1 "Player-lite": one record keyed by `player_id`, unified across 1..N brands via a
 * `PlayerBrand` edge. That premise is false — GR8's `player_id` is unique only WITHIN a brand, so the
 * same value under two brands is two different people, and "unification" was collision. The tests
 * below now assert the repaired shape, and the old assertions are kept in the comments as the record
 * of what was believed: the edge existing was, at the time, the thing being verified.
 *
 * The GR8-seam half is untouched and still correct.
 */
describe('Player-lite entity + opaque GR8 seam (ADR 0032)', () => {
  const users = () => parseSchema('users');
  const player = () => users().find((m) => m.name === 'Player')!;
  const playerBrand = () => users().find((m) => m.name === 'PlayerBrand');

  it('*** Player is keyed by (account_id, brand_id, player_id) — not by the platform id ***', () => {
    // Was: `expect(idIndex?.columns).toEqual(['player_id'])`. That key made two brands' customers ONE
    // ROW. `account_id` leads so the injected isolation predicate stays index-aligned — and so two
    // future licensees can both hold player `12345`.
    const idIndex = player().indexes.find((i) => i.kind === 'id');
    expect(idIndex?.columns).toEqual(['account_id', 'brand_id', 'player_id']);
  });

  it('brand_id is a column on the player, not an edge to somewhere else', () => {
    expect(getField(player(), 'brand_id')?.baseType).toBe('String');
  });

  it('the brand-union edge PlayerBrand is GONE', () => {
    // Was: `expect(pb!.isJoinTable).toBe(true)`. With brand in the key a row IS one brand's player, so
    // a many-to-many edge to brands can no longer state anything true. "This human exists on several
    // brands" is now a Person, established from a matching email or phone — never from an id match.
    expect(playerBrand()).toBeUndefined();
  });

  it('a human spanning brands is modelled explicitly, and carries no contact value', () => {
    const person = users().find((m) => m.name === 'Person');
    const member = users().find((m) => m.name === 'PersonMember');
    expect(person).toBeDefined();
    expect(member).toBeDefined();
    // `linked_on` records WHICH KIND of identifier established the link, never the value (SEC-26).
    expect(getField(member!, 'linked_on')?.baseType).toBe('String');
    expect(member!.fields.map((f) => f.name)).not.toContain('email');
    expect(member!.fields.map((f) => f.name)).not.toContain('phone');
  });

  it('the contact-match projection stores a HASH and no plaintext', () => {
    const cm = users().find((m) => m.name === 'ContactMatch');
    expect(cm).toBeDefined();
    const names = cm!.fields.map((f) => f.name);
    expect(names).toContain('value_hash');
    // The property that keeps this table out of the tier policy: there is nothing to classify.
    for (const forbidden of ['email', 'phone', 'value', 'contact']) {
      expect(names).not.toContain(forbidden);
    }
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
