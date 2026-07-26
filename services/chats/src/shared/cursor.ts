/**
 * Keyset pagination primitives for chats reads (feature 012, research R7 / N1).
 *
 * Lists order by `(created_at DESC, id DESC)`; the cursor is the last row's `(created_at, id)`,
 * base64-encoded and opaque to the client. `page_size` is clamped to a server maximum so no caller
 * can pull an unbounded slice of the ~372K-row history (Principle VII). No offset, no COUNT.
 */

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

export class InvalidCursorError extends Error {
  constructor() {
    super('invalid page token');
    this.name = 'InvalidCursorError';
  }
}
