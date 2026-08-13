import { keysetPredicate, orderByFor, sortKeyOf, valuesOf, type OrderPart } from './order-parts';
import { InvalidCursorError } from '../shared/cursor';

/**
 * T037 (feature 031, roadmap 4.19) — the generated keyset, and the one property that matters.
 *
 * ⚠️ **A wrong keyset predicate is invisible.** It does not throw and it does not return an empty page: it
 * returns a plausible page two with some rows repeated and some missing. So the assertions here are not
 * about the shape of the generated object — they are about paging a known sequence and getting every row
 * exactly once. The shape assertions exist only to prove the three shipped orders were not disturbed.
 */

const UPDATED_DESC: readonly OrderPart[] = [
  { column: 'updated_at', direction: 'desc', type: 'time' },
];
const URGENCY: readonly OrderPart[] = [
  { column: 'priority_rank', direction: 'desc', type: 'int' },
  { column: 'updated_at', direction: 'asc', type: 'time' },
];

describe('the shipped single-column orders are UNCHANGED', () => {
  it('orderBy is still the column then the id, same direction', () => {
    expect(orderByFor(UPDATED_DESC)).toEqual([{ updated_at: 'desc' }, { id: 'desc' }]);
  });

  it('⭐ the token is still the bare ISO timestamp — no cursor minted before this feature is broken', () => {
    const at = new Date('2026-08-04T10:00:00.000Z');
    expect(sortKeyOf({ updated_at: at, id: 'c-1' }, UPDATED_DESC)).toBe('2026-08-04T10:00:00.000Z');
  });

  it('the predicate is the same two-clause shape the repository used to build by hand', () => {
    const at = new Date('2026-08-04T10:00:00.000Z');
    expect(keysetPredicate(UPDATED_DESC, at.toISOString(), 'c-9')).toEqual({
      OR: [{ updated_at: { lt: at } }, { AND: [{ updated_at: at }, { id: { lt: 'c-9' } }] }],
    });
  });
});

describe('the two-column urgency order', () => {
  it('orders by rank then wait, with the id following the INNERMOST direction', () => {
    // ⚠️ `id: 'asc'`, not `desc`. The id breaks ties inside an equal `(rank, updated_at)` pair, and the
    // predicate compares it with `>` there — a `desc` id in the sort would contradict that and drop rows.
    expect(orderByFor(URGENCY)).toEqual([
      { priority_rank: 'desc' },
      { updated_at: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('round-trips both values through the token', () => {
    const at = new Date('2026-08-04T10:00:00.000Z');
    const key = sortKeyOf({ priority_rank: 3, updated_at: at, id: 'c-1' }, URGENCY);
    expect(key).toBe('3~2026-08-04T10:00:00.000Z');
    expect(valuesOf(key, URGENCY)).toEqual([3, at]);
  });

  it('⛔ a token whose shape does not match the order is REFUSED, never coerced', () => {
    // Feature 029's rule: a mismatched token must not silently restart at page one and must not continue
    // in a different sequence. Feature 012's live defect was a silently coerced unknown value.
    expect(() => valuesOf('2026-08-04T10:00:00.000Z', URGENCY)).toThrow(InvalidCursorError);
    expect(() => valuesOf('3~not-a-date', URGENCY)).toThrow(InvalidCursorError);
    expect(() => valuesOf('high~2026-08-04T10:00:00.000Z', URGENCY)).toThrow(InvalidCursorError);
  });
});

// ── ⭐ The property that actually matters: page the whole sequence ──────────────────────────────────

type Row = { id: string; priority_rank: number; updated_at: Date };

/** Just enough of a predicate evaluator for the clause shapes {@link keysetPredicate} generates. */
function matches(row: Row, clause: Record<string, unknown>): boolean {
  return Object.entries(clause).every(([key, value]) => {
    if (key === 'OR') return (value as Record<string, unknown>[]).some((c) => matches(row, c));
    if (key === 'AND') return (value as Record<string, unknown>[]).every((c) => matches(row, c));
    const actual = row[key as keyof Row];
    const cmp = (a: unknown, b: unknown) => {
      if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
      // ⚠️ Strings compare as STRINGS. The `id` tie-break is a string comparison, and coercing it to a
      // number turns every id comparison into NaN — which silently drops exactly the tied rows the
      // tie-break exists to keep. (This evaluator learnt that the hard way.)
      if (typeof a === 'string' || typeof b === 'string')
        return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
      return Number(a) - Number(b);
    };
    if (value instanceof Date) return cmp(actual, value) === 0;
    if (value !== null && typeof value === 'object') {
      const op = value as { lt?: unknown; gt?: unknown };
      if ('lt' in op) return cmp(actual, op.lt) < 0;
      if ('gt' in op) return cmp(actual, op.gt) > 0;
      return false;
    }
    if (typeof actual === 'string') return actual === value;
    return cmp(actual, value) === 0;
  });
}

function sortBy(rows: Row[], parts: readonly OrderPart[]): Row[] {
  const keys = orderByFor(parts);
  return [...rows].sort((a, b) => {
    for (const spec of keys) {
      const [col, dir] = Object.entries(spec)[0]!;
      const av = a[col as keyof Row];
      const bv = b[col as keyof Row];
      let d = 0;
      if (av instanceof Date && bv instanceof Date) d = av.getTime() - bv.getTime();
      else if (typeof av === 'string' && typeof bv === 'string') d = av < bv ? -1 : av > bv ? 1 : 0;
      else d = Number(av) - Number(bv);
      if (d !== 0) return dir === 'desc' ? -d : d;
    }
    return 0;
  });
}

/** Page `rows` two at a time, exactly as the repository does. */
function pageThrough(rows: Row[], parts: readonly OrderPart[], size: number): string[] {
  const ordered = sortBy(rows, parts);
  const seen: string[] = [];
  let cursor: { sortKey: string; id: string } | null = null;
  for (let guard = 0; guard < 20; guard += 1) {
    const from = cursor;
    const eligible: Row[] = from
      ? ordered.filter((r) => matches(r, keysetPredicate(parts, from.sortKey, from.id)))
      : ordered;
    const page = eligible.slice(0, size);
    if (page.length === 0) break;
    seen.push(...page.map((r) => r.id));
    const last = page[page.length - 1]!;
    if (eligible.length <= size) break;
    cursor = { sortKey: sortKeyOf(last, parts), id: last.id };
  }
  return seen;
}

describe('⭐ paging the whole sequence returns every row EXACTLY once', () => {
  const t = (min: number) => new Date(Date.UTC(2026, 7, 4, 10, min));
  const rows: Row[] = [
    { id: 'a', priority_rank: 3, updated_at: t(5) },
    // ⚠️ A deliberate FULL TIE with 'a' on both ordered columns: the id tie-break is the only thing
    // separating them, and a keyset that omits it loops or skips forever.
    { id: 'b', priority_rank: 3, updated_at: t(5) },
    { id: 'c', priority_rank: 3, updated_at: t(9) },
    { id: 'd', priority_rank: 2, updated_at: t(1) },
    { id: 'e', priority_rank: 0, updated_at: t(2) },
    { id: 'f', priority_rank: 0, updated_at: t(30) },
  ];

  it('under the urgency order', () => {
    const paged = pageThrough(rows, URGENCY, 2);
    // highest rank first; within a rank the LONGEST wait first; ties by id.
    expect(paged).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('under a single-column order, with a page size that divides the set exactly', () => {
    // The off-by-one case: the last page is full, so `hasMore` is decided by the extra row the
    // repository takes rather than by a short page.
    const paged = pageThrough(rows, UPDATED_DESC, 3);
    // ⓘ 'b' before 'a': under a descending order the id tie-break descends too, or the predicate's
    // `id < …` comparison contradicts the sort.
    expect(paged).toEqual(['f', 'c', 'b', 'a', 'e', 'd']);
  });

  it('⚠️ POSITIVE CONTROL: drop the id tie-break and a TIED row vanishes without a trace', () => {
    // Without this, the assertions above are satisfied by any paging that happens to work on data with no
    // ties — which is most data, most of the time, which is why this class of bug reaches production.
    //
    // The naive predicate below is the one a careful person writes by hand: lexicographic over the two
    // ordered columns, no tie-break. Page one ends ON a tie, and its twin is then excluded for ever.
    const naive = (sortKey: string) => {
      const [rank, at] = sortKey.split('~');
      return {
        OR: [
          { priority_rank: { lt: Number(rank) } },
          { AND: [{ priority_rank: Number(rank) }, { updated_at: { gt: new Date(at!) } }] },
        ],
      };
    };
    const ordered = sortBy(rows, URGENCY);
    const first = ordered[0]!; // 'a' — tied with 'b' on BOTH ordered columns
    const afterNaive = ordered
      .filter((r) => matches(r, naive(sortKeyOf(first, URGENCY))))
      .map((r) => r.id);
    const afterReal = ordered
      .filter((r) => matches(r, keysetPredicate(URGENCY, sortKeyOf(first, URGENCY), first.id)))
      .map((r) => r.id);

    expect(afterNaive).not.toContain('b'); // ⛔ lost: no error, no empty page, just a missing row
    expect(afterReal).toContain('b'); // ⭐ kept, and only because of the tie-break
  });
});
