import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ⭐⭐ **EXACTLY ONE WebSocket GATEWAY, ON ONE AUTHORIZED PATH** (feature 034, W4 — FR-006).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * Authorization on this edge is done by one `handleConnection`, and sockets are matched by PATH — so a
 * second gateway class is not defence-in-depth, it is a coin toss. `AuthGuard` returns `true` for every
 * non-HTTP context by design, so there is nothing behind it.
 *
 * ⚠️ **Measured, not theorised.** This file first asserted "every gateway declares `/ws`", and with two
 * classes on that path a browser's handshake was closed while `handleConnection` NEVER RAN — the gateway
 * logged nothing at all. Two `@WebSocketGateway` classes do not compose under the native `ws` adapter: the
 * adapter binds one, and the one it bound had no connection handler. The suite was green over a dead edge,
 * which is the one thing a guard must never be.
 *
 * ⇒ So the rule is stronger than "same path": **there is one gateway, and it is the one that authorizes.**
 * Spec 003's `ping`/`pong` lives inside it (that claim — REST and realtime on one port — still needs
 * demonstrating), rather than in a class of its own.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */
const WS_DIR = __dirname;
const AUTHORIZED_PATH = "path: '/ws'";

const files = readdirSync(WS_DIR).filter((f) => f.endsWith('.gateway.ts'));

describe('the WebSocket surface has exactly one, authorized, path', () => {
  it('there is exactly ONE gateway class', () => {
    // ⚠️ The count IS the assertion now: a second class means a coin toss over which one the adapter binds.
    expect(files).toEqual(['realtime.gateway.ts']);
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
  it('that one gateway authorizes the handshake, and answers ping', () => {
    const src = readFileSync(join(WS_DIR, 'realtime.gateway.ts'), 'utf8');
    expect(src).toContain('verifyAccessToken');
    // Spec 003's US4 proof lives here now, not in a second class.
    expect(src).toContain("@SubscribeMessage('ping')");
  });
});
