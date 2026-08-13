/**
 * Fair round-robin selection (feature 013, US3 — roadmap 4.4 / research R3).
 *
 * A **pure** module: no Prisma, no clock, no I/O. That is deliberate — the live source of candidates
 * (teams + operator capacity) lives in the Users service, so the algorithm is proven here over an
 * explicitly provided candidate set and simply gets a real feed from `group-pool.ts`.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⭐ **THE CURSOR NAMES A PERSON, NOT A POSITION — and that is the whole design (fixed 2026-08-13).**
 *
 * ── The defect this replaces, because it must not come back ────────────────────────────────────
 * The cursor used to be an INDEX into the candidate list. The list is sorted by operator id, which
 * looked stable enough — but it holds only the people **available right now**, so it changes LENGTH
 * every time somebody goes online or offline. An index into a list that grows and shrinks points at
 * a different person after every such change:
 *
 *   `[Ann, Bob, Cara, Dan, Eve]`, cursor 3 (Dan was last) → Ann goes offline
 *   `[Bob, Cara, Dan, Eve]`,      cursor 3 now means Eve   → next pick is Bob, and **Eve is skipped**
 *   Ann comes back                                          → the shift runs the other way and
 *                                                             somebody receives two in a row
 *
 * Nobody would ever see this as an error. It surfaces only as «why does Cara get everything and
 * Dan almost nothing», weeks later, in a queue that looks like it is working. The operator named
 * exactly this failure on 2026-08-13 — *«чтобы не было такого, что человек зашёл или вышел из сети,
 * список обновился, и мы заново с первого начинаем»* — which is what sent us to look.
 *
 * ── Why an ID cursor fixes it completely ───────────────────────────────────────────────────────
 * The candidate list is sorted by operator id, so an id is a POSITION IN THE ROTATION that exists
 * independently of who is currently present. «Continue after Dan» means the same thing whether Ann
 * is online or not — and it still means something after **Dan himself** leaves: the rotation resumes
 * at the first person who sorts after him. Arrivals and departures no longer move anybody's turn.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 */

export interface RoundRobinCandidate {
  operatorId: string;
  capacity: number;
  currentLoad: number;
}

export interface RoundRobinSelection {
  /** The chosen operator, or null when none is available. */
  operatorId: string | null;
  /**
   * The cursor to persist: the operator just served. Unchanged from `lastOperatorId` when nothing
   * was selected, so a round where everybody is busy does not cost anyone their turn.
   */
  nextOperatorId: string | null;
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
 * @param candidates the candidate set, in any order — see the sort below.
 * @param lastOperatorId the operator served last, or `null`/`''` when the rotation has never run.
 */
export function selectRoundRobin(
  candidates: readonly RoundRobinCandidate[],
  lastOperatorId: string | null,
): RoundRobinSelection {
  const n = candidates.length;
  if (n === 0) return { operatorId: null, nextOperatorId: lastOperatorId };

  /**
   * ⚠️ **Sorted HERE, not trusted from the caller.** «Continue after Dan» is only a rotation if the
   * order is by id; over an arbitrary order «the first id greater than Dan» can be a person already
   * behind us, and the same colleague is served twice in a row. `group-pool.ts` does sort its pool,
   * and this function was first written to rely on that — until its own test handed it an unsorted
   * list and produced exactly that repeat. A guarantee that depends on every caller remembering is
   * not a guarantee; sorting a handful of candidates costs nothing.
   */
  const ordered = [...candidates].sort((a, b) => a.operatorId.localeCompare(b.operatorId));

  /**
   * Where the rotation stands, expressed in the CURRENT list.
   *
   * ⚠️ `> last` rather than `indexOf(last)`, and the difference is the point: the person who was
   * served last may be **gone** — that is the ordinary case, since they may have just logged off.
   * Asking «who is the first person after them?» still has an answer when they are absent, so the
   * rotation survives the departure of the very person it was pointing at. When nobody sorts after
   * them (they were last alphabetically, or the list is now smaller) the search wraps to the start,
   * which is the correct continuation of a cycle.
   */
  const last = lastOperatorId ?? '';
  let start = ordered.findIndex((c) => c.operatorId.localeCompare(last) > 0);
  if (start === -1) start = 0;

  for (let step = 0; step < n; step += 1) {
    const candidate = ordered[(start + step) % n];
    if (isAvailable(candidate)) {
      return { operatorId: candidate.operatorId, nextOperatorId: candidate.operatorId };
    }
  }

  // Everyone is at capacity: leave the conversation unassigned and the cursor where it was.
  return { operatorId: null, nextOperatorId: lastOperatorId };
}
