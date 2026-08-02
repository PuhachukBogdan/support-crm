import type { HttpPort, HttpRequest } from './http-port';

/**
 * T015 [027] — the 401 → refresh → retry rotation. It lives HERE, in the transport, and not in the
 * session boundary or in a screen.
 *
 * ── Why the transport ───────────────────────────────────────────────────────────────────────────
 * The `access` cookie is short-lived **by design**; the 1-day / 7-day window lives on `refresh`.
 * Without a client that rotates, a session dies at the access lifetime and SC-005 — "the session
 * survives a browser restart within the window" — is simply false, while every unit test with a
 * mocked transport passes either way.
 *
 * A rotation in `Session` would cover only the calls `Session` makes. Every other request in the
 * product would still die at the access expiry, and the symptom would be *"some pages log me out"* —
 * the hardest possible shape to diagnose. ADR 0037's page-first rule assigns cross-cutting
 * machinery to the first page that needs it; this is that page.
 *
 * ── Two rules, both of which exist because of a specific failure ────────────────────────────────
 * ⚠️ **Exactly one attempt.** A rotation that retries on the retry's failure loops — against the
 * authentication endpoint of a service that rate-limits.
 *
 * ⚠️ **Auth calls are excluded.** Refreshing because a password was rejected is nonsense: it would
 * double every failed sign-in, and it would answer a 401 that means "those credentials are wrong"
 * with machinery meant for a 401 that means "this token aged out".
 */

/** The rotation endpoint, and the calls that must never trigger it (they ARE the auth flow). */
export const REFRESH_PATH = '/auth/refresh';
const NO_ROTATION = new Set([
  '/auth/login',
  '/auth/verify',
  '/auth/register/start',
  '/auth/register/complete',
  '/auth/logout',
  REFRESH_PATH,
]);

/** True when a 401 from this path means "wrong credentials", not "the access token aged out". */
export function isAuthCall(path: string): boolean {
  return NO_ROTATION.has(path);
}

/**
 * Wrap a port so an expired access token is rotated once and the original request replayed.
 *
 * `onSessionLost` fires when the rotation itself is refused — the session is over, and the layer
 * above needs to know without reading a status code to find out.
 */
export function withRefreshRotation(inner: HttpPort, onSessionLost?: () => void): HttpPort {
  return async (req: HttpRequest) => {
    const first = await inner(req);
    if (first.status !== 401 || isAuthCall(req.path)) return first;

    const rotated = await inner({ path: REFRESH_PATH, method: 'POST' });
    if (rotated.status !== 200) {
      onSessionLost?.();
      // The ORIGINAL answer is returned, unchanged. Replacing it with the rotation's answer would
      // report a failed refresh as the outcome of a request that was never retried.
      return first;
    }

    return inner(req);
  };
}
