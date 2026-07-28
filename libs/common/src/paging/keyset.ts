/**
 * Keyset pagination primitives (feature 018, research R6).
 *
 * A list orders by `(created_at DESC, id DESC)` and the cursor is the last row's pair, base64-encoded
 * and opaque to the client. No offset, no `COUNT` — Principle VII.
 *
 * ── Why the token is opaque, and what that does NOT buy ──────────────────────────────────────────
 * Opacity stops a client treating the position as an API it can compute. It does **not** make the token
 * unforgeable and it does **not** bind the token to the query that produced it: a well-formed token from
 * a different filter simply resumes at that position. That is safe, and the reason is worth stating
 * because it is not obvious — **every predicate is re-applied on every page and none of them travels
 * inside the token**, so a foreign cursor can shift where a page starts and can never widen what it may
 * contain. A malformed token is a different matter and throws.
 *
 * *(Established during feature 018's analysis pass, which found a requirement promising that a foreign
 * token would be REFUSED — something a position cursor cannot do, since it carries no query identity.)*
 *
 * ── ⚠️ There is a second copy of this primitive ───────────────────────────────────────────────────
 * `services/chats/src/shared/cursor.ts` is the same shape, service-local, and predates this one. It was
 * deliberately NOT migrated here: doing so would touch a dozen shipped controllers for no functional
 * gain inside the point that needed the primitive. Whoever next has a reason to unify them should find
 * both — hence this note in both files.
 *
 * Pure module: no I/O, no clock, no Prisma.
 */

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;

/** Clamp a requested page size: ≤0 / missing → default; above the cap → cap (Principle VII). */
export function clampPageSize(requested: number | undefined | null): number {
  if (!requested || requested <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(requested), MAX_PAGE_SIZE);
}

export interface Cursor {
  /** ISO-8601 `created_at` of the last row on the previous page. */
  createdAt: string;
  /** That row's id — the tie-breaker, without which rows sharing an instant can be skipped. */
  id: string;
}

/** Encode a keyset cursor to an opaque token. */
export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.createdAt, c.id]), 'utf8').toString('base64url');
}

/**
 * Decode an opaque page token.
 *
 * `null` for an empty token (= first page). **Throws** for a malformed one — never a silent fall back to
 * an unfiltered first page, which would answer a different question than the caller asked and look like
 * success while doing it.
 */
export function decodeCursor(token: string | undefined | null): Cursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      parsed[0].length > 0 &&
      parsed[1].length > 0
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
