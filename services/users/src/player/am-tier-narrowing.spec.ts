import {
  allowedFields,
  surfacedMaskableTiers,
  surfacedMaskableTiersForRole,
  visibleTiersFor,
  visibleTiersForSubject,
} from '@crm/common';
import { maskPlayer } from './player.masking';

/**
 * T023/T024/T026 (feature 026, roadmap 5.7) — ⭐ **THE POINT OF THE FEATURE.**
 *
 * Before this, the `am_only` tier was gated BY ROLE ALONE: anybody with the AM role read the
 * portfolio of every player in the account. Roadmap 5.7 requires that an AM cannot read a player
 * they are not attached to, so this is not an addition — it **narrows something already shipped**.
 *
 * Which means the risk is inverted, and these tests are written for the inverted risk: the danger is
 * not "the new thing fails", it is **"something that worked yesterday stops working"**. So the
 * exemptions are asserted as loudly as the narrowing.
 */

const PLAYER = {
  player_id: 'ply-1',
  brand_id: 'brand-a',
  vip: true,
  segment: 'gold',
  am_notes: 'prefers calls after 18:00',
  preferences: '{"channel":"telegram"}',
  portfolio: '{"tier":"gold"}',
  gr8_snapshot: '{"secret":true}',
};

const attached = { attachedToSubject: true };
const not = { attachedToSubject: false };

describe('⭐ the derived rule: am_only needs the tier AND (admin clearance OR attachment)', () => {
  it('an ATTACHED AM sees the tier', () => {
    expect(visibleTiersForSubject('am', attached)).toContain('am_only');
  });

  it('⭐ an UNATTACHED AM does not', () => {
    expect(visibleTiersForSubject('am', not)).not.toContain('am_only');
  });

  it('the same holds for a shift AM', () => {
    expect(visibleTiersForSubject('shift_am', attached)).toContain('am_only');
    expect(visibleTiersForSubject('shift_am', not)).not.toContain('am_only');
  });

  it('⭐ an administrator is EXEMPT, attached or not', () => {
    // Making an administrator attach themselves to read a record would be theatre, and their reads
    // are already audited (ADR 0032 §4A's broad-by-default stance).
    for (const role of ['admin', 'super_admin']) {
      expect(visibleTiersForSubject(role, not)).toContain('am_only');
    }
  });

  it('⭐ what EXEMPTS a role is holding `masked_pii`, not its NAME', () => {
    // The rule is derived from the tier map rather than from a list like ['am','shift_am']. A list
    // drifts the first time a role is added, and drifts silently; this self-maintains, and in the
    // safe direction both ways.
    const exempt = Object.keys({
      admin: 1,
      super_admin: 1,
      am: 1,
      shift_am: 1,
      vip_support: 1,
    }).filter(
      (r) =>
        visibleTiersFor(r).includes('am_only') &&
        visibleTiersForSubject(r, not).includes('am_only'),
    );
    for (const r of exempt) expect(visibleTiersFor(r)).toContain('masked_pii');
  });

  it('roles below the tier are untouched — nothing widened', () => {
    for (const role of ['support_agent', 'teamlead', 'vip_support']) {
      expect(visibleTiersForSubject(role, attached)).toEqual(visibleTiersFor(role));
    }
  });

  it('⭐ ONLY `am_only` narrows — `open` and `operational` stay role-gated', () => {
    // This is what keeps the feature from locking itself out: an AM must see enough of an UNATTACHED
    // player to attach them, or self-assignment is unreachable and the whole thing deadlocks.
    const tiers = visibleTiersForSubject('am', not);
    expect(tiers).toContain('open');
    expect(tiers).toContain('operational');
  });
});

describe('the masked record: ABSENT, not empty', () => {
  it('an attached AM gets the portfolio fields', () => {
    const out = maskPlayer(PLAYER, 'am', attached) as Record<string, unknown>;
    expect(out.am_notes).toBe('prefers calls after 18:00');
    expect(out.portfolio).toContain('gold');
  });

  it('⭐ an unattached AM gets them STRUCTURALLY ABSENT', () => {
    // Not null, not ''. Feature 011 FR-014: a masked field is missing, so a role that may not see it
    // is indistinguishable from a record where it happened to be empty.
    const out = maskPlayer(PLAYER, 'am', not) as Record<string, unknown>;
    for (const field of ['am_notes', 'preferences', 'portfolio']) {
      expect(field in out).toBe(false);
    }
  });

  it('…and still sees who the player is', () => {
    const out = maskPlayer(PLAYER, 'am', not) as Record<string, unknown>;
    expect(out.player_id).toBe('ply-1');
    expect(out.vip).toBe(true); // `operational` — untouched by the narrowing
  });

  it('an unattached AM still gets NO masked_pii — the narrowing removes, never adds', () => {
    const out = maskPlayer(PLAYER, 'am', not) as Record<string, unknown>;
    expect('gr8_snapshot' in out).toBe(false);
  });

  it('an unattached AM sees EXACTLY what a vip_support role sees', () => {
    // The clean way to state "the tier is gone": the AM's field set collapses to the tier below.
    const am = Object.keys(maskPlayer(PLAYER, 'am', not)).sort();
    const vip = Object.keys(maskPlayer(PLAYER, 'vip_support', not)).sort();
    expect(am).toEqual(vip);
  });

  it('allowedFields agrees with the masking, since one drives the other', () => {
    expect(allowedFields('am', not).has('am_notes')).toBe(false);
    expect(allowedFields('am', attached).has('am_notes')).toBe(true);
  });
});

describe('⭐ the access audit records what was ACTUALLY surfaced (research R4)', () => {
  it('an attached AM surfaces am_only, and the entry may say so', () => {
    expect(surfacedMaskableTiers('am', attached)).toEqual(['operational', 'am_only']);
  });

  it('⭐ an unattached AM does NOT, and the entry must not claim it', () => {
    // The call site used to say the recorded tier follows the caller's CLEARANCE rather than which
    // fields held a value — right while clearance was a property of the role alone. It is now a
    // property of the role AND this record. An entry claiming an unattached AM read the portfolio
    // would OVERSTATE the one trail whose job is detecting over-reach, and a trail that overstates is
    // worse than one that understates: its false entries look exactly like its true ones.
    expect(surfacedMaskableTiers('am', not)).toEqual(['operational']);
  });

  it('⚠️ the BULK read keeps the role-level answer, and that is the opposite decision', () => {
    // Its entry names a BRAND, not a record — there is no single attachment to ask about, and the
    // caller's clearance genuinely can surface the tier for whichever rows they are attached to.
    // Narrowing here would UNDERSTATE, which is the mirror mistake and just as wrong.
    expect(surfacedMaskableTiersForRole('am')).toEqual(['operational', 'am_only']);
  });
});
