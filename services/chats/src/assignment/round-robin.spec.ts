import { selectRoundRobin, type RoundRobinCandidate } from './round-robin';

/**
 * T030 (feature 013, US3) — the pure rotation algorithm. SC-003 is the load-bearing assertion:
 * N assignments over K available candidates differ by at most one, at-capacity operators are never
 * chosen, and an exhausted/empty set yields no assignment (never a guess).
 */

const c = (operatorId: string, capacity = 5, currentLoad = 0): RoundRobinCandidate => ({
  operatorId,
  capacity,
  currentLoad,
});

/** Run `times` selections, feeding each result's cursor into the next call. */
function rotate(candidates: RoundRobinCandidate[], times: number, from = -1) {
  const picks: (string | null)[] = [];
  let cursor = from;
  for (let i = 0; i < times; i += 1) {
    const r = selectRoundRobin(candidates, cursor);
    picks.push(r.operatorId);
    cursor = r.nextCursor;
  }
  return { picks, cursor };
}

describe('selectRoundRobin — fair rotation (SC-003)', () => {
  it('starts at the first candidate on a fresh rotation (cursor -1)', () => {
    expect(selectRoundRobin([c('a'), c('b')], -1)).toEqual({ operatorId: 'a', nextCursor: 0 });
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
    expect(selectRoundRobin([c('a'), c('b'), c('c')], 1)).toEqual({
      operatorId: 'c',
      nextCursor: 2,
    });
  });
});

describe('selectRoundRobin — capacity', () => {
  it('skips a candidate at capacity', () => {
    const r = selectRoundRobin([c('a', 2, 2), c('b', 2, 0)], -1);
    expect(r).toEqual({ operatorId: 'b', nextCursor: 1 });
  });

  it('skips a candidate OVER capacity (load beyond the limit)', () => {
    const r = selectRoundRobin([c('a', 1, 5), c('b', 3, 1)], -1);
    expect(r.operatorId).toBe('b');
  });

  it('treats zero (or negative) capacity as unavailable', () => {
    expect(selectRoundRobin([c('a', 0, 0), c('b', 3, 0)], -1).operatorId).toBe('b');
    expect(selectRoundRobin([c('a', -1, 0)], -1).operatorId).toBeNull();
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
    expect(selectRoundRobin([], 3)).toEqual({ operatorId: null, nextCursor: 3 });
  });

  it('returns null when EVERY candidate is at capacity, and keeps the cursor', () => {
    expect(selectRoundRobin([c('a', 1, 1), c('b', 2, 2)], 1)).toEqual({
      operatorId: null,
      nextCursor: 1,
    });
  });

  it('ignores a candidate with a blank operator id', () => {
    expect(selectRoundRobin([c('', 5, 0)], -1).operatorId).toBeNull();
    expect(selectRoundRobin([c('', 5, 0), c('b', 5, 0)], -1).operatorId).toBe('b');
  });

  it('never returns an operator absent from the input', () => {
    const candidates = [c('a'), c('b')];
    for (let i = 0; i < 5; i += 1) {
      const r = selectRoundRobin(candidates, i - 1);
      if (r.operatorId !== null) {
        expect(candidates.map((x) => x.operatorId)).toContain(r.operatorId);
      }
    }
  });
});

describe('selectRoundRobin — robustness', () => {
  it('recovers from a stored cursor beyond the current candidate count', () => {
    // The candidate set shrank since the cursor was written; selection must still be valid.
    const r = selectRoundRobin([c('a'), c('b')], 99);
    expect(['a', 'b']).toContain(r.operatorId);
    expect(r.nextCursor).toBeGreaterThanOrEqual(0);
    expect(r.nextCursor).toBeLessThan(2);
  });

  it('tolerates a garbage cursor (non-integer / below -1)', () => {
    expect(selectRoundRobin([c('a')], Number.NaN).operatorId).toBe('a');
    expect(selectRoundRobin([c('a')], -50).operatorId).toBe('a');
  });

  it('is pure — the same inputs always give the same answer, and inputs are not mutated', () => {
    const candidates = [c('a'), c('b')];
    const snapshot = JSON.stringify(candidates);
    expect(selectRoundRobin(candidates, 0)).toEqual(selectRoundRobin(candidates, 0));
    expect(JSON.stringify(candidates)).toBe(snapshot);
  });
});
