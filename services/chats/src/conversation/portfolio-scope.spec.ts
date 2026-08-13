import { Metadata } from '@grpc/grpc-js';
import { ROLE_VISIBLE_TIERS } from '@crm/common';
import { callerActingRole, inPortfolio, narrowsToPortfolio } from './portfolio-scope';

/** T008 — who is narrowed, derived from 026's rule rather than from a list of role names. */

const asRole = (role: string) => {
  const md = new Metadata();
  md.set('x-actor-effective-role', role);
  return md;
};

describe('who is narrowed to their own portfolio', () => {
  it('narrows the roles that see am_only without the administrative clearance', () => {
    expect(narrowsToPortfolio(asRole('am'))).toBe(true);
    expect(narrowsToPortfolio(asRole('shift_am'))).toBe(true);
  });

  it('does NOT narrow administrators — masked_pii IS the administrative clearance', () => {
    expect(narrowsToPortfolio(asRole('admin'))).toBe(false);
    expect(narrowsToPortfolio(asRole('super_admin'))).toBe(false);
  });

  it('does not narrow a role that never sees am_only at all', () => {
    expect(narrowsToPortfolio(asRole('support_agent'))).toBe(false);
    expect(narrowsToPortfolio(asRole('vip_support'))).toBe(false);
    expect(narrowsToPortfolio(asRole('teamlead'))).toBe(false);
  });

  it('⭐ is DERIVED, so a role added later is classified without touching this file (SC-006/FR-004)', () => {
    // The derivation self-maintains in both safe directions: a new role given `am_only` alone is
    // narrowed; a new role given `masked_pii` is administrative by definition. A hardcoded
    // ['am','shift_am'] would drift the first time a role is added, and drift silently.
    const derived = Object.entries(ROLE_VISIBLE_TIERS)
      .filter(([, tiers]) => tiers.includes('am_only') && !tiers.includes('masked_pii'))
      .map(([role]) => role)
      .sort();

    for (const role of derived) expect(narrowsToPortfolio(asRole(role))).toBe(true);
    for (const [role, tiers] of Object.entries(ROLE_VISIBLE_TIERS)) {
      if (!derived.includes(role)) expect(narrowsToPortfolio(asRole(role))).toBe(false);
      // Positive control on the fixture itself: an empty tier map would satisfy every loop above.
      expect(tiers.length).toBeGreaterThan(0);
    }
    expect(derived.length).toBeGreaterThan(0);
  });

  it('⚠️ an absent or unknown role does NOT narrow — it agrees with the tier system', () => {
    /**
     * ⚠️ **This assertion was the opposite way round first, and the gateway settled it.**
     * `actor-metadata.ts` sets `x-actor-effective-role` only `if (resolved?.roleKey)`, so an absent role
     * is a reachable NORMAL state — narrowing on it would empty the queue for every such caller, a worse
     * outcome than the over-reach this point removes. Sixteen existing specs failed and proved the state
     * is ordinary rather than exceptional.
     *
     * It is also what the product already answers: `visibleTiersFor('')` → `['open']`, i.e. least
     * privileged and NOT an AM. Such a caller therefore receives no `am_only` field either, which bounds
     * the exposure — and narrowing here while masking there would be two mechanisms disagreeing about who
     * an AM is (ADR 0039 §2).
     */
    expect(narrowsToPortfolio(new Metadata())).toBe(false);
    expect(narrowsToPortfolio(undefined)).toBe(false);
    expect(narrowsToPortfolio(asRole(''))).toBe(false);
    expect(narrowsToPortfolio(asRole('role_invented_next_year'))).toBe(false);
  });

  it('reads the ACTING role, not the underlying one (view-as preview)', () => {
    const md = new Metadata();
    md.set('x-actor-role', 'super_admin'); // who they are
    md.set('x-actor-effective-role', 'am'); // who they are acting as
    expect(callerActingRole(md)).toBe('am');
    // The preview answers "what can this ROLE do?" — so it is narrowed, and the owner's own clearance
    // does not leak into it.
    expect(narrowsToPortfolio(md)).toBe(true);
  });
});

describe('the predicate matches the PAIR, never a bare player id', () => {
  const portfolio = [{ brandId: 'b1', playerId: 'p1' }];

  it('matches an attached (brand, player)', () => {
    expect(inPortfolio({ brand_id: 'b1', player_id: 'p1' }, portfolio)).toBe(true);
  });

  it('⚠️ REFUSES the same player id under a different brand — two different human beings', () => {
    // ADR 0038 §3 had to fix exactly this collision once; a narrowing meant to improve privacy must not
    // reintroduce it one layer down.
    expect(inPortfolio({ brand_id: 'b2', player_id: 'p1' }, portfolio)).toBe(false);
  });

  it('excludes an unidentified conversation from every portfolio', () => {
    expect(inPortfolio({ brand_id: 'b1', player_id: null }, portfolio)).toBe(false);
    expect(inPortfolio({ brand_id: null, player_id: 'p1' }, portfolio)).toBe(false);
    expect(inPortfolio({}, portfolio)).toBe(false);
  });

  it('an empty portfolio matches nothing — never everything', () => {
    expect(inPortfolio({ brand_id: 'b1', player_id: 'p1' }, [])).toBe(false);
  });
});
