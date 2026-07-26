import {
  MINUTE_MS,
  decideStart,
  decideStop,
  isDueForBreach,
  type SlaStateSnapshot,
} from './first-reply';

/**
 * T032 (feature 014, US2) — the clock state machine, over an injected clock. FAILS before the module
 * exists, PASSES after.
 *
 * The two assertions this feature would be wrong without:
 *  • a **private note does not stop the clock** (FR-012 / SC-007). An internal note is not an answer
 *    to the player, and treating it as one would let a conversation count as "replied" while the
 *    player is still waiting — the SEC-13 distinction applied to a new surface.
 *  • the target is **frozen at start** (FR-016 / research R8), so editing the policy later cannot
 *    retro-breach or un-breach anything.
 */
const T0 = new Date('2026-07-27T12:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const running = (over: Partial<SlaStateSnapshot> = {}): SlaStateSnapshot => ({
  outcome: 'running',
  started_at: T0,
  target_minutes: 10,
  deadline_at: at(10 * MINUTE_MS),
  first_reply_at: null,
  breach_announced_at: null,
  ...over,
});

describe('decideStart', () => {
  it('starts a clock on the first inbound message and FREEZES the target onto the row', () => {
    const intent = decideStart(null, 15, T0)!;
    expect(intent).toEqual({
      started_at: T0,
      target_minutes: 15,
      deadline_at: at(15 * MINUTE_MS),
    });
  });

  // A chatty player must not be able to keep resetting the clock, or nothing would ever breach.
  it('does NOT restart an existing clock on a later inbound message', () => {
    expect(decideStart(running(), 15, at(MINUTE_MS))).toBeNull();
    expect(decideStart(running({ outcome: 'met' }), 15, at(MINUTE_MS))).toBeNull();
    expect(decideStart(running({ outcome: 'breached' }), 15, at(MINUTE_MS))).toBeNull();
  });

  it('starts nothing when no target applies (absence is not a zero target)', () => {
    expect(decideStart(null, null, T0)).toBeNull();
    expect(decideStart(null, 0, T0)).toBeNull();
    expect(decideStart(null, -1, T0)).toBeNull();
  });
});

describe('decideStop — the private-note rule (FR-012 / SC-007)', () => {
  it('*** a private note does NOT stop the clock and does not count as a reply ***', () => {
    expect(decideStop(running(), false, at(MINUTE_MS))).toBeNull();
  });

  it('a public reply within the target stops it as met, with the measured duration', () => {
    const stop = decideStop(running(), true, at(90_000))!; // 90 s
    expect(stop).toEqual({ outcome: 'met', first_reply_at: at(90_000), first_reply_seconds: 90 });
  });

  // "We replied, 40 minutes late" is the operationally useful fact — so the duration is recorded but
  // the outcome stays breached. A late reply must not rescue the SLA.
  it('a public reply AFTER the deadline stays breached but still records the duration', () => {
    const stop = decideStop(running(), true, at(40 * MINUTE_MS))!;
    expect(stop.outcome).toBe('breached');
    expect(stop.first_reply_seconds).toBe(40 * 60);
  });

  it('is terminal: a second reply never changes a decided outcome', () => {
    expect(decideStop(running({ outcome: 'met', first_reply_at: at(1000) }), true, at(5000))).toBeNull();
    expect(decideStop(running({ outcome: 'breached' }), true, at(5000))).toBeNull();
  });

  it('does nothing when there is no clock at all', () => {
    expect(decideStop(null, true, T0)).toBeNull();
  });

  it('never reports a negative duration if a reply timestamp precedes the start', () => {
    expect(decideStop(running(), true, at(-5000))!.first_reply_seconds).toBe(0);
  });
});

describe('isDueForBreach', () => {
  it('is true exactly at and after the deadline for a running clock', () => {
    expect(isDueForBreach(running(), at(10 * MINUTE_MS - 1))).toBe(false);
    expect(isDueForBreach(running(), at(10 * MINUTE_MS))).toBe(true);
    expect(isDueForBreach(running(), at(11 * MINUTE_MS))).toBe(true);
  });

  it('is false for an already-decided clock', () => {
    expect(isDueForBreach(running({ outcome: 'met' }), at(99 * MINUTE_MS))).toBe(false);
    expect(isDueForBreach(running({ outcome: 'breached' }), at(99 * MINUTE_MS))).toBe(false);
  });

  // The stamp is what makes a breach fire exactly once, ever — a second sweep must find nothing.
  it('is false once the breach has been announced', () => {
    expect(isDueForBreach(running({ breach_announced_at: at(10 * MINUTE_MS) }), at(99 * MINUTE_MS))).toBe(
      false,
    );
  });
});

describe('the frozen target (FR-016)', () => {
  it('a policy change cannot move an in-flight deadline — the row carries its own', () => {
    const state = running({ target_minutes: 10, deadline_at: at(10 * MINUTE_MS) });
    // The account target is now 1 minute; the running clock is unaffected because nothing re-reads
    // the policy for an existing row.
    expect(isDueForBreach(state, at(2 * MINUTE_MS))).toBe(false);
    expect(decideStop(state, true, at(2 * MINUTE_MS))!.outcome).toBe('met');
  });
});
