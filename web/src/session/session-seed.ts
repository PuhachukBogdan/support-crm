import { cookies } from 'next/headers';
import type { SessionState } from './session';

/**
 * T017 [027] — the server-rendered seed (research §3, FR-022, SC-006).
 *
 * ⚠️ **Server-only.** It imports `next/headers`, so it must never be pulled into a client bundle —
 * which is why it is not re-exported from `./index`. Its one caller is the root layout.
 *
 * ── The defect it prevents ──────────────────────────────────────────────────────────────────────
 * With SSR, a session check that runs only in the browser paints the sign-in page for a signed-in
 * person and then replaces it. That is a visible, reported-as-a-bug defect, not a theoretical one.
 * The server can see the cookie; the browser cannot. Using the side that can see is the whole idea.
 *
 * ── ⚠️ THE TRAP, written down because it is the tempting version ────────────────────────────────
 * **A cookie's presence is not proof of a valid session.** An expired cookie is still a cookie. So
 * this function never returns `authenticated`:
 *
 *   no cookie at all → `anonymous`. This IS authoritative — no cookie, no session, and the sign-in
 *                      page can paint immediately with nothing to correct later.
 *   a cookie present → `resolving`. A hint that something might be there, and the gateway is asked.
 *                      Holding is right: we never paint an answer we have not received.
 *
 * Middleware that redirected on cookie presence alone would be cheaper to write and would silently
 * convert an expired cookie into "logged in" — putting an authentication decision in the browser,
 * which is the exact thing this feature exists to remove (Principle II).
 */

/** Set by the gateway (`services/gateway/src/auth/session-cookie.ts`); both are httpOnly. */
export const ACCESS_COOKIE = 'access';
export const REFRESH_COOKIE = 'refresh';

export async function readSessionSeed(): Promise<SessionState> {
  const jar = await cookies();
  // The refresh cookie counts as well: the access cookie is short-lived by design, so "access is
  // gone" is a routine state for a session that is still perfectly alive and about to be rotated.
  const hasHint = jar.has(ACCESS_COOKIE) || jar.has(REFRESH_COOKIE);
  return hasHint ? { kind: 'resolving' } : { kind: 'anonymous' };
}
