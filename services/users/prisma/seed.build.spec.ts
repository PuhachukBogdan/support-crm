import { buildSeed } from './seed.build';
import {
  SEED_ACCOUNT_ID,
  SEED_AUTH_USER_ID,
  SEED_PLAYER_ID,
  SEED_BRAND_ID,
  SEED_BRAND_ID_2,
} from '@crm/common';

/**
 * US1 (feature 008): the users seed builder yields an operator + a player linked to the brand via the
 * union edge, with the GR8 seam unpopulated/stale. Pure — no DB (Track A).
 */
describe('users seed builder', () => {
  const seed = buildSeed();

  it('every tenant row carries the seed account_id (SC-003)', () => {
    for (const row of [...seed.operators, ...seed.players]) {
      expect(row.account_id).toBe(SEED_ACCOUNT_ID);
    }
  });

  it('the operator references the shared auth user (soft ref)', () => {
    expect(seed.operators[0]!.auth_user_id).toBe(SEED_AUTH_USER_ID);
  });

  /**
   * ⚠️ **NARROWED by feature 022.** These two assertions used to be about the WHOLE fixture (`players` has
   * length 2, and its two entries are the collision pair). Feature 022 added a second, opposite pair — two
   * DISTINCT platform ids, one per brand, explicitly linked into one person — so the assertions now select
   * the pair they are about instead of assuming it is the only one.
   *
   * Nothing they proved is weakened: the collision fixture is still exactly two records, still one platform
   * id, still one per brand, still differing in every other field.
   */
  const collisionPair = () => seed.players.filter((p) => p.player_id === SEED_PLAYER_ID);

  it('*** the SAME platform id is seeded under BOTH brands, as two different people ***', () => {
    // Feature 020's permanent fixture. GR8's player_id is unique only within a brand, so this is what
    // real data looks like — and it is the case that four phases of tests never once exercised.
    expect(collisionPair()).toHaveLength(2);
    expect(collisionPair().map((p) => p.brand_id)).toEqual([SEED_BRAND_ID, SEED_BRAND_ID_2]);
  });

  it('the two collide only on the id — every other field differs, and would have been overwritten', () => {
    const [a, b] = collisionPair();
    expect(a!.vip).not.toBe(b!.vip);
    expect(a!.segment).not.toBe(b!.segment);
    expect(a!.am_notes).not.toBe(b!.am_notes);
  });

  it('feature 022: ONE person links TWO records with DISTINCT ids, one per brand', () => {
    // The opposite fixture, and the live run needs both: with only the collision pair, "the person feed
    // spans brands" cannot be falsified; with only this one, "an id match is not a person" cannot.
    expect(seed.persons).toHaveLength(1);
    expect(seed.personMembers).toHaveLength(2);
    const ids = seed.personMembers.map((m) => m.player_id);
    expect(new Set(ids).size).toBe(2); // distinct platform ids — a LINK, not a collision
    expect(seed.personMembers.map((m) => m.brand_id)).toEqual([SEED_BRAND_ID, SEED_BRAND_ID_2]);
    for (const m of seed.personMembers) {
      expect(m.person_id).toBe(seed.persons[0]!.id);
      expect(m.account_id).toBe(SEED_ACCOUNT_ID);
    }
  });

  it('feature 022: every linked member is also seeded as a PLAYER (the FK would refuse otherwise)', () => {
    // `PersonMember` carries a real foreign key to `Player` on the triple — the one place in this schema
    // where a link is enforced by the database. A member with no player row is a seed that dies on the
    // constraint, which is the constraint doing its job.
    for (const m of seed.personMembers) {
      const exists = seed.players.some(
        (p) => p.player_id === m.player_id && p.brand_id === m.brand_id && p.account_id === m.account_id,
      );
      expect({ member: m.player_id, hasPlayerRow: exists }).toEqual({
        member: m.player_id,
        hasPlayerRow: true,
      });
    }
  });

  it('feature 022: the link records the KIND of identifier, never a value (SEC-26)', () => {
    for (const m of seed.personMembers) {
      expect(['email', 'phone']).toContain(m.linked_on);
      // No fixture may carry an address or a number: `linked_on` says HOW, and nothing says WHAT.
      expect(JSON.stringify(m)).not.toMatch(/@|\+\d{5}/);
    }
  });

  it('the brand-union edge is gone — a row IS one brand’s player', () => {
    expect(seed).not.toHaveProperty('playerBrands');
  });

  it('the GR8 cache seam is left unpopulated/stale', () => {
    expect(seed.players[0]!.gr8_stale).toBe(true);
    expect(seed.players[0]!.gr8_snapshot ?? null).toBeNull();
  });
});
