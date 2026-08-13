import { isQueueRole, narrowsToOwnPortfolio, ROLE_VISIBLE_TIERS } from '@crm/common';
import {
  costOfChannel,
  hasRoomFor,
  PROVISIONAL_CHANNEL_COST,
  PROVISIONAL_UNIT_BUDGET,
  unitsUsed,
} from './capacity';

/**
 * T006–T008 (feature 031, roadmap 4.21 / ADR 0042 §3).
 *
 * ⚠️ Every "no room" assertion carries its positive control: the same held set with one input changed
 * must have room. Otherwise "no room" is satisfied by arithmetic that always says no.
 */

const chat = (n: number) => Array.from({ length: n }, () => ({ channel: 'chat' }));

describe('units and the budget', () => {
  it('counts one unit per single-unit conversation', () => {
    expect(unitsUsed(chat(3))).toBe(3);
    expect(unitsUsed([])).toBe(0);
  });

  it('at budget there is no room; one below there is (positive control)', () => {
    expect(hasRoomFor(chat(PROVISIONAL_UNIT_BUDGET), 'chat')).toBe(false);
    expect(hasRoomFor(chat(PROVISIONAL_UNIT_BUDGET - 1), 'chat')).toBe(true);
  });

  it('a freed unit gives the room back', () => {
    const full = chat(PROVISIONAL_UNIT_BUDGET);
    expect(hasRoomFor(full, 'chat')).toBe(false);
    expect(hasRoomFor(full.slice(1), 'chat')).toBe(true);
  });

  it('⚠️ an absent channel is NOT free', () => {
    // ~1 in 6 conversations carry no channel. Pricing them at zero would let one agent accumulate work
    // the budget cannot see.
    expect(costOfChannel(undefined)).toBe(1);
    expect(costOfChannel('')).toBe(1);
    expect(unitsUsed([{ channel: null }, { channel: undefined }])).toBe(2);
  });

  it('an unknown channel costs one unit rather than nothing', () => {
    // A channel arriving before anybody prices it is still work.
    expect(costOfChannel('carrier-pigeon')).toBe(1);
  });

  it('⚠️ over budget is not an error — it is simply no room until it drains', () => {
    // An administrator may lower a budget below what somebody already holds; existing work is never
    // taken away.
    expect(hasRoomFor(chat(6), 'chat', 4)).toBe(false);
    expect(unitsUsed(chat(6))).toBe(6);
  });

  it('a budget change is reflected immediately, with no restart involved', () => {
    const held = chat(4);
    expect(hasRoomFor(held, 'chat', 4)).toBe(false);
    expect(hasRoomFor(held, 'chat', 6)).toBe(true);
  });
});

describe('exclusive channels consume the whole person', () => {
  it('holding an exclusive conversation leaves room for nothing', () => {
    expect(unitsUsed([{ channel: 'voice' }])).toBe('exclusive');
    expect(hasRoomFor([{ channel: 'voice' }], 'chat', 99)).toBe(false);
  });

  it('an exclusive conversation needs the person entirely free, not merely under budget', () => {
    expect(hasRoomFor(chat(1), 'voice', 4)).toBe(false);
    // Positive control: with nothing held, the same request fits.
    expect(hasRoomFor([], 'voice', 4)).toBe(true);
  });

  it('⚠️ a large budget cannot override exclusivity', () => {
    // Collapsing "exclusive" into a big number is how a generous budget would quietly re-admit work.
    expect(hasRoomFor([{ channel: 'voice' }], 'chat', 1000)).toBe(false);
  });
});

describe('⭐ FR-013 holds BY CONSTRUCTION, and the coupling is asserted', () => {
  it('no role is both a queue role and portfolio-narrowed', () => {
    // Portfolio conversations must consume no queue capacity. That needs no filter here because the
    // router only considers queue roles, and the derivation excludes exactly the roles holding a
    // portfolio. ⚠️ Asserted because the day `isQueueRole` widens, this module needs a real filter and
    // its absence would be silent.
    for (const role of Object.keys(ROLE_VISIBLE_TIERS)) {
      expect(isQueueRole(role) && narrowsToOwnPortfolio(role)).toBe(false);
    }
  });

  it('the provisional numbers are overridable arguments, not constants', () => {
    // 🅿 The operator has not confirmed them; T025 moves them into configuration. A module that could
    // only use its own defaults would have hardened his placeholder into a requirement.
    expect(hasRoomFor(chat(2), 'chat', 2)).toBe(false);
    expect(hasRoomFor(chat(2), 'chat', 3)).toBe(true);
    expect(hasRoomFor([], 'chat', 4, { chat: 'exclusive' })).toBe(true);
    expect(hasRoomFor(chat(1), 'chat', 4, { chat: 'exclusive' })).toBe(false);
    expect(PROVISIONAL_CHANNEL_COST.voice).toBe('exclusive');
  });
});
