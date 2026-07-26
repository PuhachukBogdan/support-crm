/**
 * Fair round-robin selection (feature 013, US3 — roadmap 4.4 / research R3).
 *
 * A **pure** module: no Prisma, no clock, no I/O. That is deliberate — the live source of candidates
 * (teams + operator capacity) lives in the Users service and is not built yet (roadmap 5.3), so the
 * algorithm is proven now over an explicitly provided candidate set and simply gets a real feed
 * later. Nothing here needs to change when that happens.
 *
 * Fairness comes from a persisted cursor: selection starts at `lastCursor + 1` and wraps, so
 * consecutive calls hand out consecutive operators instead of always picking the first free one.
 * Candidates at or over capacity are skipped. When nobody has capacity — or the set is empty — the
 * result is `null` and the cursor is left untouched, so the next call resumes where it was rather
 * than drifting.
 */

export interface RoundRobinCandidate {
  operatorId: string;
  capacity: number;
  currentLoad: number;
}

export interface RoundRobinSelection {
  /** The chosen operator, or null when none is available. */
  operatorId: string | null;
  /** The cursor to persist. Unchanged from `lastCursor` when nothing was selected. */
  nextCursor: number;
}

/** A candidate is eligible when it names an operator and has room left. */
function isAvailable(c: RoundRobinCandidate | undefined): c is RoundRobinCandidate {
  if (!c) return false;
  if (!c.operatorId) return false;
  const capacity = Number.isFinite(c.capacity) ? c.capacity : 0;
  const load = Number.isFinite(c.currentLoad) ? c.currentLoad : 0;
  return capacity > 0 && load < capacity;
}

/**
 * Pick the next operator by fair rotation.
 *
 * @param candidates ordered candidate set (the order defines the rotation)
 * @param lastCursor index of the previously chosen candidate; `-1` = rotation never used
 */
export function selectRoundRobin(
  candidates: readonly RoundRobinCandidate[],
  lastCursor: number,
): RoundRobinSelection {
  const n = candidates.length;
  if (n === 0) return { operatorId: null, nextCursor: lastCursor };

  // Normalise a cursor that is out of range (candidate set changed since it was stored).
  const start = Number.isInteger(lastCursor) && lastCursor >= -1 ? lastCursor : -1;

  for (let step = 1; step <= n; step += 1) {
    const index = (((start + step) % n) + n) % n;
    const candidate = candidates[index];
    if (isAvailable(candidate)) {
      return { operatorId: candidate.operatorId, nextCursor: index };
    }
  }

  // Everyone is at capacity: leave the conversation unassigned and the cursor where it was.
  return { operatorId: null, nextCursor: lastCursor };
}
