import { selectRoundRobin, type RoundRobinCandidate } from './round-robin';

/**
 * T030 (feature 013, US3) — the pure rotation algorithm. SC-003 is the load-bearing assertion:
 * N assignments over K available candidates differ by at most one, at-capacity operators are never
 * chosen, and an exhausted/empty set yields no assignment (never a guess).
 *
 * ⭐ **Rewritten 2026-08-13: the cursor names a PERSON, not a position.** The whole last block of
 * this file is the reason — a pool that changes size as people log on and off made an index-based
 * cursor point at somebody else, and the unfairness that produced is invisible to every other test
 * here. See `round-robin.ts` for the worked example.
 */

const c = (operatorId: string, capacity = 5, currentLoad = 0): RoundRobinCandidate => ({
  operatorId,
  capacity,
  currentLoad,
});

/** Run `times` selections, feeding each result's cursor into the next call. */
function rotate(candidates: RoundRobinCandidate[], times: number, from: string | null = null) {
  const picks: (string | null)[] = [];
  let cursor = from;
  for (let i = 0; i < times; i += 1) {
    const r = selectRoundRobin(candidates, cursor);
    picks.push(r.operatorId);
    cursor = r.nextOperatorId;
  }
  return { picks, cursor };
}

describe('selectRoundRobin — fair rotation (SC-003)', () => {
  it('starts at the first candidate on a fresh rotation (no cursor)', () => {
    expect(selectRoundRobin([c('a'), c('b')], null)).toEqual({ operatorId: 'a', nextOperatorId: 'a' });
  });

  it('advances one position per call and wraps around', () => {
    const { picks } = rotate([c('a'), c('b'), c('c')], 7);
    expect(picks).toEqual(['a', 'b', 'c', 'a', 'b', 'c', 'a']);
  });

  it('gives everyone a turn before anyone repeats', () => {
    const { picks } = rotate([c('a'), c('b'), c('c')], 3);
    expect(new Set(picks).size).toBe(3);
  });

  it('distributes N assignments over K candidates within one of even (SC-003)', () => {
    const candidates = [c('a', 100), c('b', 100), c('c', 100), c('d', 100)];
    const { picks } = rotate(candidates, 26);
    const counts = candidates.map((x) => picks.filter((p) => p === x.operatorId).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(26);
  });

  it('resumes from a stored cursor rather than restarting', () => {
    expect(selectRoundRobin([c('a'), c('b'), c('c')], 'b')).toEqual({
      operatorId: 'c',
      nextOperatorId: 'c',
    });
  });
});

describe('selectRoundRobin — capacity', () => {
  it('skips a candidate at capacity', () => {
    expect(selectRoundRobin([c('a', 2, 2), c('b', 2, 0)], null)).toEqual({
      operatorId: 'b',
      nextOperatorId: 'b',
    });
  });

  it('skips a candidate OVER capacity (load beyond the limit)', () => {
    expect(selectRoundRobin([c('a', 1, 5), c('b', 3, 1)], null).operatorId).toBe('b');
  });

  it('treats zero (or negative) capacity as unavailable', () => {
    expect(selectRoundRobin([c('a', 0, 0), c('b', 3, 0)], null).operatorId).toBe('b');
    expect(selectRoundRobin([c('a', -1, 0)], null).operatorId).toBeNull();
  });

  it('only ever rotates among those with room left', () => {
    const candidates = [c('a', 5, 0), c('full', 1, 1), c('b', 5, 0)];
    const { picks } = rotate(candidates, 6);
    expect(picks).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
    expect(picks).not.toContain('full');
  });
});

describe('selectRoundRobin — nothing available', () => {
  it('returns null for an empty candidate set and keeps the cursor', () => {
    expect(selectRoundRobin([], 'c')).toEqual({ operatorId: null, nextOperatorId: 'c' });
  });

  it('returns null when EVERY candidate is at capacity, and keeps the cursor', () => {
    expect(selectRoundRobin([c('a', 1, 1), c('b', 2, 2)], 'b')).toEqual({
      operatorId: null,
      nextOperatorId: 'b',
    });
  });

  it('ignores a candidate with a blank operator id', () => {
    expect(selectRoundRobin([c('', 5, 0)], null).operatorId).toBeNull();
    expect(selectRoundRobin([c('', 5, 0), c('b', 5, 0)], null).operatorId).toBe('b');
  });

  it('never returns an operator absent from the input', () => {
    const candidates = [c('a'), c('b')];
    for (const from of [null, 'a', 'b', 'zzz', '']) {
      const r = selectRoundRobin(candidates, from);
      if (r.operatorId !== null) {
        expect(candidates.map((x) => x.operatorId)).toContain(r.operatorId);
      }
    }
  });
});

describe('selectRoundRobin — robustness', () => {
  it('recovers when the stored cursor names somebody no longer in the pool', () => {
    // They logged off. The rotation resumes at the first id AFTER them, not at the top.
    expect(selectRoundRobin([c('a'), c('c'), c('d')], 'b').operatorId).toBe('c');
  });

  it('wraps when the stored cursor sorts after everybody present', () => {
    expect(selectRoundRobin([c('a'), c('b')], 'z').operatorId).toBe('a');
  });

  it('is pure — the same inputs always give the same answer, and inputs are not mutated', () => {
    const candidates = [c('a'), c('b')];
    const snapshot = JSON.stringify(candidates);
    expect(selectRoundRobin(candidates, 'a')).toEqual(selectRoundRobin(candidates, 'a'));
    expect(JSON.stringify(candidates)).toBe(snapshot);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⭐ **THE POOL CHANGES SIZE ALL DAY — the rotation must not care** (operator, 2026-08-13).
 *
 * *«чтобы не было такого, что человек зашёл или вышел из сети, список обновился, и мы заново с
 * первого начинаем»* — the pool holds only the people available RIGHT NOW, so it grows and shrinks
 * every time somebody logs on, goes to lunch or comes back. Every test above passes over a FIXED
 * list, which is exactly why the defect lived: it needs a list that changes between calls to appear.
 *
 * ⚠️ These four fail on the index-based cursor. They are the specification of fairness.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe('*** ⭐ fairness across arrivals and departures ***', () => {
  const pool = (...ids: string[]) => ids.map((id) => c(id, 100, 0));

  it('*** somebody logging off does not cost the next person their turn ***', () => {
    // Dan was served last. Ann then logs off, so the list shrinks — under an index cursor, position
    // 3 now means Eve and Eve is skipped. The turn belongs to Eve either way.
    const after = selectRoundRobin(pool('bob', 'cara', 'dan', 'eve'), 'dan');
    expect(after.operatorId).toBe('eve');
  });

  it('*** somebody arriving does not give the last person a second turn ***', () => {
    // Eve was served last; Ann comes back, so every index shifts up by one and an index cursor
    // lands on Eve again. By name it wraps to Ann, which is whose turn it actually is.
    const after = selectRoundRobin(pool('ann', 'bob', 'cara', 'dan', 'eve'), 'eve');
    expect(after.operatorId).toBe('ann');
  });

  it('*** the rotation survives the departure of the very person it points at ***', () => {
    // Dan was served last and has now logged off himself. «After Dan» still has an answer.
    expect(selectRoundRobin(pool('ann', 'bob', 'cara', 'eve'), 'dan').operatorId).toBe('eve');
  });

  it('*** ⭐ nobody is starved over a shift of constant coming and going ***', () => {
    /**
     * The real shape of a working day: five colleagues, one of whom logs on and off repeatedly
     * while tickets keep arriving. With an index cursor the churn re-points the rotation and the
     * people near the top of the alphabet collect far more work than the rest — the operator's own
     * words: *«одним и тем же людям… постоянно приходят новые тикеты, а до последних почти не
     * доходит»*. The spread below is the assertion; on the old algorithm it blows past 1.
     */
    const everyone = ['ann', 'bob', 'cara', 'dan', 'eve'];
    const counts = new Map(everyone.map((id) => [id, 0]));
    let cursor: string | null = null;

    for (let i = 0; i < 60; i += 1) {
      /**
       * `cara` steps away on every third ticket — on and off all shift.
       *
       * ⚠️ Three, not two, and the reason is worth keeping: with FIVE colleagues an every-other-tick
       * absence beats in lock-step with the rotation, so she can be absent almost every time her
       * turn comes round. That produces a starved-looking result from a perfectly fair algorithm —
       * the test would be measuring a resonance between two periods rather than the property. A
       * period coprime with the pool size measures what it claims to.
       */
      const present = everyone.filter((id) => id !== 'cara' || i % 3 !== 0);
      const r = selectRoundRobin(pool(...present), cursor);
      if (r.operatorId) counts.set(r.operatorId, counts.get(r.operatorId)! + 1);
      cursor = r.nextOperatorId;
    }

    // The four who were always there must be within one of each other. Cara is excluded from the
    // comparison — she was available half the time, so fewer tickets is correct, not unfair.
    const steady = everyone.filter((id) => id !== 'cara').map((id) => counts.get(id)!);
    expect(Math.max(...steady) - Math.min(...steady)).toBeLessThanOrEqual(1);
    /**
     * …and she is not starved either: absence costs her only the tickets she was away for, never a
     * place in the cycle.
     *
     * ⚠️ Stated as a PROPORTION of what a steady colleague received, not as a fixed number. Cara is
     * present for two ticks in three, so a fixed expectation would be pinning an arithmetic
     * coincidence between the rotation length, the run length and her absence period — the kind of
     * assertion that goes red on a change that improves nothing and breaks nothing.
     */
    const steadyAverage = steady.reduce((a, b) => a + b, 0) / steady.length;
    expect(counts.get('cara')!).toBeGreaterThan(steadyAverage * 0.4);
  });
});
