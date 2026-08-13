import { InvalidCursorError } from '../shared/cursor';

/**
 * Keyset ordering over MORE THAN ONE column (feature 031, roadmap 4.19).
 *
 * ── Why this file exists ────────────────────────────────────────────────────────────────────────
 * The conversation list's three shipped orders are each one column plus the `id` tie-break, and the
 * repository built the `orderBy` and the cursor predicate from one `{ column, direction }` record —
 * with a comment warning that if the two ever disagree, *"page two is drawn from a different sequence
 * than page one, and the result is not an error but a plausible list with rows repeated and rows
 * missing."*
 *
 * The urgency order is the first with **two** columns (rank, then how long it has waited). Written by
 * hand, its keyset predicate is three nested clauses that have to agree with a three-part `orderBy` —
 * precisely the drift the original comment feared, with three times the surface. So both are derived
 * here from one declaration, for every order including the old ones.
 *
 * ── ⚠️ The token format is UNCHANGED for a single-part order ────────────────────────────────────
 * The encoded key is the parts joined by `~`, which for one part is the bare ISO timestamp the shipped
 * cursor already carried. No token minted before this feature is invalidated, and no client notices.
 */

/** One component of an order, most significant first. `id` is appended automatically. */
export interface OrderPart {
  column: 'created_at' | 'updated_at' | 'priority_rank';
  direction: 'asc' | 'desc';
  /** How the value round-trips through the page token — a timestamp is not a number. */
  type: 'time' | 'int';
}

/**
 * ⚠️ A character that cannot appear in an ISO-8601 timestamp or a decimal integer, so a two-part key
 * cannot be split in the wrong place by a value that contains the separator.
 */
const SEP = '~';

/** The row shape the encoder needs: whatever columns the order names, plus the id. */
type Sortable = Record<string, unknown>;

/**
 * `orderBy` for Prisma. The `id` tie-break follows the **innermost** part's direction — a keyset needs
 * the whole ordering pointing one way at the level it compares, or the `id` comparison in the predicate
 * below contradicts the sort.
 */
export function orderByFor(parts: readonly OrderPart[]): Record<string, 'asc' | 'desc'>[] {
  const innermost = parts[parts.length - 1]!.direction;
  return [...parts.map((p) => ({ [p.column]: p.direction })), { id: innermost }];
}

/** The page token's sort key: the last row's value for each part, in order. */
export function sortKeyOf(row: Sortable, parts: readonly OrderPart[]): string {
  return parts
    .map((p) => {
      const v = row[p.column];
      if (p.type === 'time') return (v as Date).toISOString();
      // A null rank cannot occur (the column is NOT NULL with a default) but a defensive 0 keeps a
      // malformed row from minting a token that decodes to NaN and pages nothing.
      return String(typeof v === 'number' ? v : 0);
    })
    .join(SEP);
}

/**
 * Decode a sort key back into typed values.
 *
 * ⛔ Throws rather than coercing: a token whose shape does not match the order it claims must be refused,
 * never silently restarted at page one and never continued in a different sequence (the feature-029 rule,
 * and the feature-012 lesson about silently coerced unknown values).
 */
export function valuesOf(sortKey: string, parts: readonly OrderPart[]): (Date | number)[] {
  const raw = sortKey.split(SEP);
  if (raw.length !== parts.length) throw new InvalidCursorError();
  return parts.map((p, i) => {
    const text = raw[i]!;
    if (p.type === 'time') {
      const at = new Date(text);
      if (Number.isNaN(at.getTime())) throw new InvalidCursorError();
      return at;
    }
    const n = Number(text);
    if (!Number.isInteger(n)) throw new InvalidCursorError();
    return n;
  });
}

/**
 * The keyset predicate: *everything strictly after this row in this sequence.*
 *
 * Lexicographic over the parts, then the `id` tie-break — one `OR` clause per part, each pinning the
 * more significant parts to equality. Generated, because the hand-written two-column version is where
 * a page-two-from-a-different-sequence bug lives and it cannot be seen in a review.
 */
export function keysetPredicate(
  parts: readonly OrderPart[],
  sortKey: string,
  id: string,
): Record<string, unknown> {
  const values = valuesOf(sortKey, parts);
  const beyond = (p: OrderPart, v: Date | number) =>
    p.direction === 'desc' ? { lt: v } : { gt: v };
  const equalTo = (upTo: number) =>
    parts.slice(0, upTo).map((p, j) => ({ [p.column]: values[j]! }));

  const clauses: unknown[] = parts.map((p, i) => {
    const pinned = equalTo(i);
    const step = { [p.column]: beyond(p, values[i]!) };
    return pinned.length === 0 ? step : { AND: [...pinned, step] };
  });

  // All parts equal ⇒ the id decides, in the innermost direction.
  const innermost = parts[parts.length - 1]!;
  clauses.push({
    AND: [
      ...equalTo(parts.length),
      { id: innermost.direction === 'desc' ? { lt: id } : { gt: id } },
    ],
  });

  return { OR: clauses };
}
