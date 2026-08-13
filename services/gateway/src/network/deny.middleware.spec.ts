import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Request, Response } from 'express';
import { denyMiddleware } from './deny.middleware';
import type { DeniedAddressCache } from './denied-address.cache';

/**
 * ⭐ W32 (roadmap 12.10) — a banned address is refused BEFORE anybody is authenticated.
 *
 * ── Why the structural half of this file is not decoration ──────────────────────────────────────
 * The behavioural tests below prove the function refuses. They cannot prove it runs EARLY ENOUGH,
 * and «early enough» is the whole requirement: a deny check that runs after authentication passes
 * every behavioural test while quietly failing 12.10, because a banned attacker reaching the login
 * page is exactly the case it exists to stop. Position is a property of the wiring, so the wiring is
 * what the last two tests read.
 */

const cacheOf = (addresses: string[]) => ({ current: () => addresses }) as unknown as DeniedAddressCache;

function callWith(cache: DeniedAddressCache, headers: Record<string, string> = {}, socketIp = '10.1.1.1') {
  const req = { headers, socket: { remoteAddress: socketIp } } as unknown as Request;
  const status = jest.fn().mockReturnThis();
  const end = jest.fn();
  const res = { status, end } as unknown as Response;
  const next = jest.fn();
  denyMiddleware(cache)(req, res, next);
  return { status, end, next };
}

describe('the deny middleware', () => {
  it('lets an unlisted caller through', () => {
    const { next, status } = callWith(cacheOf(['203.0.113.9']), {}, '10.1.1.1');
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it('*** ⭐ an EMPTY list denies nobody ***', () => {
    // The deliberate opposite of the account-key allow-list, where an empty list permits nobody. A
    // deployment where nobody has been banned is the ordinary state; refusing everybody there would
    // take the product off the air. `tests/network/deny-list-semantics.spec.ts` states both meanings
    // side by side so a later «consistency» change cannot invert either.
    const { next } = callWith(cacheOf([]), {}, '203.0.113.9');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('refuses a listed caller with a bare 403 and no body', () => {
    const { next, status, end } = callWith(cacheOf(['10.1.1.1']), {}, '10.1.1.1');
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    // ⛔ No body, no hint: the same answer for a route that exists and one that does not, so the
    // deny-list cannot be used to map the product.
    expect(end).toHaveBeenCalledWith();
  });

  it('*** judges the LAST forwarded entry — a client cannot spoof its way past a ban ***', () => {
    // The header reads «what the client claimed, then what our proxy saw». Reading the first entry
    // would let a banned caller prepend any address and walk straight through.
    const { next } = callWith(
      cacheOf(['203.0.113.9']),
      { 'x-forwarded-for': '198.51.100.1, 203.0.113.9' },
      '10.1.1.1',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('matches a normalised form — one machine written two ways is banned once', () => {
    const { next } = callWith(cacheOf(['203.0.113.9']), { 'x-forwarded-for': '::FFFF:203.0.113.9' });
    expect(next).not.toHaveBeenCalled();
  });
});

describe('*** ⭐ it runs before authentication, and the socket is covered too ***', () => {
  const gatewaySrc = resolve(__dirname, '..');
  const read = (rel: string) => readFileSync(join(gatewaySrc, rel), 'utf8');

  it('is registered in main.ts BEFORE helmet, cookies and every guard', () => {
    /**
     * ⚠️ Middleware rather than a guard, and the position is the requirement. Guard order in this
     * gateway is decided ONLY by the module import order in `app.module.ts`, which nothing asserts —
     * a deny guard registered after `AuthEdgeModule` would run after authentication and violate
     * 12.10 silently, with every other test still green.
     */
    const main = read('main.ts');
    const deny = main.indexOf('denyMiddleware');
    const helmet = main.indexOf('helmet(helmetOptions)');
    const cookies = main.indexOf('cookieParser()');
    expect(deny).toBeGreaterThan(-1);
    expect(deny).toBeLessThan(helmet);
    expect(deny).toBeLessThan(cookies);
  });

  it('*** the WebSocket carries the SAME check, because middleware cannot reach it ***', () => {
    /**
     * `/ws` is routed by the edge proxy straight to this service and the upgrade is handled off the
     * HTTP server's `upgrade` event — it never traverses the express stack, and both global guards
     * pass a non-HTTP context through. A ban enforced only in middleware would keep somebody out of
     * every page and leave them a live event feed: a hole nobody notices, because every HTTP test is
     * green. FR-033 requires this be answered and tested rather than assumed either way.
     */
    const socket = read('ws/realtime.gateway.ts');
    expect(socket).toContain('isAddressDenied');
    // The SAME address helper as the middleware. Two readers of the caller's address in one product
    // would eventually judge two different addresses from one connection, and only one correctly.
    expect(socket).toContain('clientAddressFrom');
  });

  it('nothing in the gateway reads the client address any other way', () => {
    // Anti-drift: `clientAddressFrom` is the single definition of «who is calling», and a second
    // extraction would make the allow-list and the deny-list disagree about one request.
    const files = ['network/deny.middleware.ts', 'ws/realtime.gateway.ts', 'provisioning/provisioning.controller.ts'];
    for (const f of files) {
      const code = read(f)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // The raw header is only ever handed TO the helper, never split or indexed by a caller.
      expect(code).not.toMatch(/x-forwarded-for'\]\s*\.\s*split/);
      expect(code).toContain('clientAddressFrom');
    }
  });
});
