import type { JwtService } from '@nestjs/jwt';
import type { RequestClaims } from './auth.guard';

/**
 * The ONE place an access token becomes claims (extracted by feature 034, W4).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **The WebSocket needed this check, and a second copy of it would have been the defect.**
 *
 * `AuthGuard` opens with `if (context.getType() !== 'http') return true;` — its own comment says
 * *"Non-HTTP contexts (WebSocket) are out of scope here and pass through"*. So the realtime edge is not
 * merely unguarded by accident: the global guard **deliberately** declines to judge it, which is exactly
 * why *"a socket bypasses the checks on the REST routes unless they are repeated"* is literal here rather
 * than theoretical.
 *
 * Repeating them is the trap. Two verifiers drift: one gains a clock-skew allowance, an issuer check or a
 * revocation list and the other does not, and the weaker one is the one an attacker uses. This function is
 * the whole check, both callers use it, and neither owns it.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Signature + expiry, verified LOCALLY against the shared `JWT_SECRET` — no gRPC or database hop on a
 * connection attempt (Principle VII), the same property the HTTP path relies on.
 *
 * Returns `null` on anything wrong: absent, malformed, expired, wrong signature, or missing the two claims
 * that make it usable. ⚠️ **One answer for every failure**, deliberately — the caller must not be able to
 * tell "expired" from "forged", and a socket has no place to report the difference anyway.
 */
export function verifyAccessToken(
  jwt: JwtService,
  secret: string,
  token: string | undefined,
): RequestClaims | null {
  if (!token) return null;
  try {
    const p = jwt.verify<{ sub?: string; account_id?: string; roles?: string[] }>(token, { secret });
    // ⚠️ Both ids are REQUIRED. A token with no account would otherwise produce claims with an empty
    // account, and an empty account is how one shared room for every tenant gets built — the failure
    // `realtimeChannel` throws on, refused a layer earlier here.
    if (!p.sub || !p.account_id) return null;
    return { userId: p.sub, accountId: p.account_id, roles: p.roles ?? [] };
  } catch {
    return null;
  }
}
