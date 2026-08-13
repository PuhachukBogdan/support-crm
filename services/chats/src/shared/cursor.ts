/**
 * Keyset pagination primitives for chats reads (feature 012, research R7 / N1).
 *
 * Lists order by `(created_at DESC, id DESC)`; the cursor is the last row's `(created_at, id)`,
 * base64-encoded and opaque to the client. `page_size` is clamped to a server maximum so no caller
 * can pull an unbounded slice of the ~372K-row history (Principle VII). No offset, no COUNT.
 *
 * ── ⚠️ There is now a SECOND copy of this primitive ───────────────────────────────────────────────
 * `libs/common/src/paging/keyset.ts` is the same shape, added by feature 018 because a new consumer in
 * another service needed it. This file was deliberately **not** migrated: doing so would touch a dozen
 * shipped controllers here for no functional gain inside the point that needed the primitive
 * (feature 018, research R6). The pointer sits in both files so whoever next has a reason to unify them
 * finds the other one — two copies with a note is reversible, three would be a convention.
 */

import { createHash } from 'node:crypto';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

/** Clamp a requested page size: ≤0 / missing → default; above the cap → cap. */
export function clampPageSize(requested: number | undefined | null): number {
  if (!requested || requested <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(requested), MAX_PAGE_SIZE);
}

export interface Cursor {
  /** ISO-8601 created_at of the last row on the previous page. */
  createdAt: string;
  /** id of that row — the tie-breaker for a stable order. */
  id: string;
}

/** Encode a keyset cursor to an opaque token. */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.createdAt, c.id]), 'utf8').toString('base64url');
}

/**
 * Decode an opaque page token. Returns `null` for an empty token (= first page) and throws for a
 * malformed one (never silently falls back to an unfiltered scan — spec Edge Cases).
 */
export function decodeCursor(token: string | undefined | null): Cursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through to the throw below
  }
  throw new InvalidCursorError();
}

/**
 * ── The ORDER-STAMPED cursor (feature 029, research R8) ──────────────────────────────────────────
 *
 * The conversation list is the first read in this product with MORE THAN ONE order, and a keyset
 * cursor means "resume after this row **in this sequence**". The two-value token above cannot name a
 * sequence, because until now there was only ever one.
 *
 * ⚠️ Left unstamped, a token minted under `updated_desc` and replayed under `updated_asc` decodes
 * perfectly and then pages a DIFFERENT sequence. That is not an error anyone sees: it is a plausible
 * list with rows missing and rows repeated. So the order travels inside the token and a mismatch is
 * refused.
 *
 * ── Why this is a SECOND primitive and not a widened `Cursor` ────────────────────────────────────
 * Six read paths share the cursor above (feeds ×2, messages, automations ×2, exports) and every one of
 * them has exactly one order, keyed on `created_at`. Widening the shared type would force an `order`
 * onto five cursors that have no such concept, and renaming its `createdAt` to `sortKey` would make
 * four of them LESS precise — there the key really is the creation time. The order-carrying cursor is
 * a different thing, so it is a different type.
 *
 * ⓘ The two encodings are mutually unreadable by construction (2-element vs 3-element array), so a
 * conversation token is refused by the message endpoints and vice versa — which is correct: they name
 * rows in unrelated sequences.
 */
export interface OrderedCursor {
  /**
   * The value of the column the list is ORDERED BY on the last row of the previous page.
   * ⚠️ Deliberately not called `createdAt`: under `updated_*` it holds `updated_at`. A tuple whose
   * meaning depends on a sibling field, while still named for one of the possibilities, is how the
   * next reader gets it wrong.
   */
  sortKey: string;
  /** id of that row — the tie-breaker for a stable order. */
  id: string;
  /** The order this token was minted under. Presenting it under any other order is refused. */
  order: string;
  /**
   * Feature 030: fingerprint of the portfolio scope this token was minted under. **Absent means the
   * caller was not portfolio-scoped** — not "any scope", which is why the comparison in
   * {@link decodeOrderedCursor} runs both ways.
   */
  scope?: string;
}

/**
 * ⭐ Feature 030 (roadmap 4.14, FR-014): a fingerprint of the portfolio a token was minted under.
 *
 * ⚠️ **A scope change is the order hazard by a different door.** Same order, same column, but a
 * *different row set* — so the keyset predicate silently skips or repeats rows, and the result is not an
 * error but a plausible list. An AM whose player is reassigned between page one and page two would get a
 * page that is wrong in a way nobody can see. The order already travels inside the token for exactly this
 * reason; the scope now travels beside it.
 *
 * Short on purpose: this is a **change detector**, not a secret and not an identifier. Sixteen base64url
 * characters of a SHA-256 make an accidental collision irrelevant, and the pairs are sorted first so two
 * equal portfolios always agree regardless of the order `users` returned them in.
 */
export function portfolioFingerprint(
  members: ReadonlyArray<{ brandId: string; playerId: string }>,
): string {
  const canonical = [...members]
    .map((m) => `${m.brandId}:${m.playerId}`)
    .sort()
    .join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('base64url').slice(0, 16);
}

export function encodeOrderedCursor(c: OrderedCursor): string {
  // The scope slot is OMITTED when there is none, so a caller who is not portfolio-scoped keeps minting
  // exactly the tokens it did before — no migration, and no token invalidated by shipping this.
  const parts = c.scope ? [c.sortKey, c.id, c.order, c.scope] : [c.sortKey, c.id, c.order];
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

/**
 * Decode an order-stamped page token, requiring it to have been minted under `expectedOrder`.
 * Returns `null` for an empty token (= first page); throws for anything else that does not match —
 * never silently restarts and never silently continues in the wrong sequence.
 */
export function decodeOrderedCursor(
  token: string | undefined | null,
  expectedOrder: string,
  /**
   * Feature 030: the fingerprint of the caller's portfolio right now, or `undefined` when they are not
   * portfolio-scoped. A mismatch — in either direction — is refused rather than paged.
   */
  expectedScope?: string,
): OrderedCursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(parsed) &&
      (parsed.length === 3 || parsed.length === 4) &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      typeof parsed[2] === 'string' &&
      parsed[2] === expectedOrder
    ) {
      const scope = parsed.length === 4 ? parsed[3] : undefined;
      /**
       * ⚠️ Compared BOTH ways. A scoped caller presenting an unscoped token is as wrong as a mismatched
       * fingerprint: it was minted when they were not narrowed, so continuing from it would page a
       * different row set. `undefined === undefined` lets an unscoped caller through untouched.
       */
      if (scope !== undefined && typeof scope !== 'string') throw new InvalidCursorError();
      if (scope !== expectedScope) throw new InvalidCursorError();
      return { sortKey: parsed[0], id: parsed[1], order: parsed[2], ...(scope ? { scope } : {}) };
    }
  } catch {
    // fall through to the throw below
  }
  throw new InvalidCursorError();
}

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid page token');
    this.name = 'InvalidCursorError';
  }
}
