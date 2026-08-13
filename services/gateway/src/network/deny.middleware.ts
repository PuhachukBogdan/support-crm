import type { Request, Response, NextFunction } from 'express';
import { clientAddressFrom, isAddressDenied } from '@crm/common';
import type { DeniedAddressCache } from './denied-address.cache';

/**
 * ⭐ W32 (roadmap 12.10) — refuse a banned address BEFORE anybody is authenticated.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **MIDDLEWARE, NOT A GUARD, AND THE DIFFERENCE IS THE REQUIREMENT.**
 *
 * Guard order in this gateway is decided by ONE thing — the order of `imports` in `app.module.ts` —
 * and no test asserts it. A deny guard registered after `AuthEdgeModule` would run AFTER
 * authentication and violate 12.10 silently: every test would still pass, and the ban would simply
 * apply one step too late. Middleware registered in `main.ts` runs before routing and before every
 * guard, so the ordering cannot drift.
 *
 * It also covers what guards do not: the five `@Public()` surfaces, including a write route (staff
 * provisioning) and the channel intake. Those are exactly the routes a banned caller would reach for.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⛔ **The refusal reveals nothing.** A bare 403 with no body: the same answer for a route that exists
 * and one that does not, so the deny-list cannot be used to map the product.
 *
 * ⚠️ It does NOT cover the WebSocket. The upgrade is handled off the HTTP server's `upgrade` event and
 * never traverses this stack — see `ws/realtime.gateway.ts`, which carries the same check for the same
 * list. Two call sites, one list, one address helper; `deny-middleware.spec.ts` asserts both exist.
 */
export function denyMiddleware(cache: DeniedAddressCache) {
  return (req: Request, res: Response, next: NextFunction): void => {
    /**
     * ⚠️ Through `clientAddressFrom`, always. It reads the LAST forwarded entry — the one our own
     * proxy appended — because the left-hand ones are whatever the client claimed. A second way of
     * obtaining the caller's address in this product would mean the allow-list and the deny-list
     * judging two different addresses from one request, and only one of them being right.
     */
    const address = clientAddressFrom(
      typeof req.headers['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'] : undefined,
      req.socket?.remoteAddress,
    );

    // An empty list denies nobody — the deliberate opposite of the account-key allow-list next door.
    if (!isAddressDenied(address, cache.current())) {
      next();
      return;
    }

    // ⛔ No body, no header, no hint. And nothing logged: the address is the one identifying value
    // this path holds, and a refusal log would be a record of who tried — which is the trail's job,
    // not a log file's.
    res.status(403).end();
  };
}
