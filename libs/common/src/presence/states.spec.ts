import {
  AVAILABILITY_ASKS,
  PRESENCE_CAUSES,
  PRESENCE_STATES,
  isAvailableFor,
  isLowerAvailability,
  isPresenceCause,
  isPresenceState,
  mayHeartbeatRaise,
  stateAllows,
  type AvailabilityAsk,
  type PresenceState,
} from './states';

/**
 * T008 (feature 025, roadmap 5.9) — the FR-010 matrix and the FR-016 monotonicity rule.
 *
 * Every cell of the matrix is written out here rather than checked against a rule, for the same
 * reason the matrix itself is: a test that re-derives the thing under test proves only that two
 * copies of one mistake agree.
 */

describe('the presence vocabulary is closed', () => {
  it('has exactly four states, ordered most- to least-available', () => {
    expect([...PRESENCE_STATES]).toEqual(['online', 'transfers_only', 'away', 'offline']);
  });

  it('has exactly three causes', () => {
    expect([...PRESENCE_CAUSES]).toEqual(['manual', 'auto_inactivity', 'admin']);
  });

  it('has exactly two kinds of ask', () => {
    expect([...AVAILABILITY_ASKS]).toEqual(['new_push', 'human_transfer']);
  });

  it('rejects anything outside the vocabulary', () => {
    // Notably `'active'` — the word this feature must never be confused with (FR-034).
    for (const bad of ['active', 'status', 'ONLINE', '', 'busy', null, 7]) {
      expect(isPresenceState(bad)).toBe(false);
    }
    expect(isPresenceCause('system')).toBe(false);
    expect(isPresenceCause('auto_inactivity')).toBe(true);
  });
});

describe('⭐ the FR-010 matrix — all four states × both asks, written out', () => {
  // The table below IS the requirement. If a cell here changes, the requirement changed.
  const CELLS: ReadonlyArray<[PresenceState, AvailabilityAsk, boolean]> = [
    ['online', 'new_push', true],
    ['online', 'human_transfer', true],
    ['transfers_only', 'new_push', false], // ⭐ the one cell where the two asks disagree
    ['transfers_only', 'human_transfer', true],
    ['away', 'new_push', false],
    ['away', 'human_transfer', false],
    ['offline', 'new_push', false],
    ['offline', 'human_transfer', false],
  ];

  it('covers every combination exactly once (so no cell is silently missing)', () => {
    expect(CELLS).toHaveLength(PRESENCE_STATES.length * AVAILABILITY_ASKS.length);
    expect(new Set(CELLS.map(([s, a]) => `${s}/${a}`)).size).toBe(CELLS.length);
  });

  it.each(CELLS)('%s + %s → %p', (state, ask, expected) => {
    expect(stateAllows(state, ask)).toBe(expected);
  });

  it('`transfers_only` is the ONLY state whose two answers differ', () => {
    // This is why it is a state and not one of the administrator-editable labels: a label carries
    // one value and could not express a two-valued answer.
    const disagreeing = PRESENCE_STATES.filter(
      (s) => stateAllows(s, 'new_push') !== stateAllows(s, 'human_transfer'),
    );
    expect(disagreeing).toEqual(['transfers_only']);
  });
});

describe('availability is three independent conditions', () => {
  const base = {
    ask: 'new_push' as const,
    operatorActive: true,
    state: 'online' as const,
    channel: null as string | null,
    blockedChannels: [] as string[],
  };

  it('an available operator with nothing blocked is available', () => {
    expect(isAvailableFor(base)).toBe(true);
  });

  it('a DEACTIVATED operator is never available, whatever their presence says', () => {
    // The two facts are separate and this is the assertion that keeps them so (FR-012 / FR-034).
    expect(isAvailableFor({ ...base, operatorActive: false })).toBe(false);
    expect(isAvailableFor({ ...base, operatorActive: false, state: 'online' })).toBe(false);
  });

  it('absence of a block means AVAILABLE for every channel', () => {
    expect(isAvailableFor({ ...base, channel: 'a-channel-nobody-has-heard-of' })).toBe(true);
  });

  it('a block removes exactly one channel and no other', () => {
    const blocked = { ...base, blockedChannels: ['live_chat'] };
    expect(isAvailableFor({ ...blocked, channel: 'live_chat' })).toBe(false);
    expect(isAvailableFor({ ...blocked, channel: 'email' })).toBe(true);
  });

  it('⭐ a block can only SUBTRACT — it never grants against the state', () => {
    // The inversion from ADR 0039 stated as a test: a group grants and never denies; a channel
    // switch denies and never grants. There is no input here that makes an `away` operator available.
    for (const channel of [null, 'email', 'live_chat']) {
      expect(isAvailableFor({ ...base, state: 'away', channel, blockedChannels: [] })).toBe(false);
    }
  });

  it('an UNRECORDED channel is answered at state level alone', () => {
    // Feature 022 keeps "no channel recorded" distinct from every channel NAME; a null must never be
    // matched against a block, or a block on the empty string would silently apply to it.
    const blocked = { ...base, blockedChannels: ['', 'email'] };
    expect(isAvailableFor({ ...blocked, channel: null })).toBe(true);
  });
});

describe('⭐ FR-016 — the sweep lowers, and only the sweep may be undone', () => {
  it('the ordering is strict and antisymmetric', () => {
    expect(isLowerAvailability('online', 'away')).toBe(true);
    expect(isLowerAvailability('away', 'online')).toBe(false);
    expect(isLowerAvailability('away', 'away')).toBe(false);
    expect(isLowerAvailability('online', 'transfers_only')).toBe(true);
    expect(isLowerAvailability('transfers_only', 'offline')).toBe(true);
  });

  it('a heartbeat may raise from a state the SWEEP set', () => {
    expect(mayHeartbeatRaise('auto_inactivity')).toBe(true);
  });

  it('a heartbeat may raise from the never-set default', () => {
    // A person who has never touched presence is `offline` with no cause; their first heartbeat is
    // what puts them online, and nothing else would.
    expect(mayHeartbeatRaise(null)).toBe(true);
  });

  it('⭐ a heartbeat may NOT undo what the person set themselves', () => {
    // Somebody on "Lunch" with an open browser stays on lunch. The system does not decide that
    // somebody's lunch is over.
    expect(mayHeartbeatRaise('manual')).toBe(false);
  });

  it('⭐ a heartbeat may NOT undo a supervisor', () => {
    // Otherwise the correction is reverted by the very stale session that made it necessary — and
    // the feature would not merely fail, it would look like it worked.
    expect(mayHeartbeatRaise('admin')).toBe(false);
  });
});
