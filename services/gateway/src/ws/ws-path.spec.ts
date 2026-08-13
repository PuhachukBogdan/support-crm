import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⭐⭐ **EVERY WebSocket gateway SITS ON THE AUTHENTICATED PATH** (feature 034, W4 — FR-006).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * Authorization on this edge is done by ONE gateway's `handleConnection`. Sockets are matched by PATH, so a
 * gateway declared on a different path is a socket surface **nobody authorizes** — `AuthGuard` returns
 * `true` for every non-HTTP context by design, so there is no second line of defence behind it.
 *
 * ⚠️ This is not hypothetical. Moving `RealtimeGateway` to `/ws` (so a reverse proxy can route it) left
 * `IngressGateway` on `/`, and for the length of one edit the root path accepted anonymous connections
 * again — the exact property the same session had just added. Caught by reasoning about the change rather
 * than by a test, which is why the test exists now.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⇒ **A security property enforced by one participant is a property every participant must be checked
 * against.** The next `@WebSocketGateway()` added to this service fails this suite until it joins the path.
 */
const WS_DIR = __dirname;
const AUTHORIZED_PATH = "path: '/ws'";

const files = readdirSync(WS_DIR).filter((f) => f.endsWith('.gateway.ts'));

describe('the WebSocket surface has exactly one, authorized, path', () => {
  it('found the gateways it is supposed to police', () => {
    // Two today. A guard over an empty set proves nothing, and a shrinking set is worth noticing too.
    expect(files.length).toBeGreaterThanOrEqual(2);
  });

  it.each(files)('%s declares the authorized path', (file) => {
    const src = readFileSync(join(WS_DIR, file), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // Every gateway must name the path explicitly: a bare `@WebSocketGateway()` serves the ROOT, which is
    // the unauthorized surface this suite exists to prevent.
    expect(code).toContain('@WebSocketGateway(');
    expect(code).toContain(AUTHORIZED_PATH);
    expect(code).not.toMatch(/@WebSocketGateway\(\s*\)/);
  });

  /** The detector must be able to fail, or this suite is decorative. */
  it('the detector rejects a bare decorator', () => {
    expect(/@WebSocketGateway\(\s*\)/.test('@WebSocketGateway()\nexport class X {}')).toBe(true);
  });

  /**
   * ⚠️ And the half that makes the path worth having: exactly one gateway authorizes, so if the
   * authorizing one is ever renamed or removed, this fails rather than silently leaving an open door.
   */
  it('exactly one gateway authorizes the handshake', () => {
    const authorizing = files.filter((f) =>
      readFileSync(join(WS_DIR, f), 'utf8').includes('verifyAccessToken'),
    );
    expect(authorizing).toEqual(['realtime.gateway.ts']);
  });
});
