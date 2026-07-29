/**
 * Web app config.
 *
 * ── The `/api` rewrite is a SECURITY decision, not plumbing (feature 019, research R1) ──────────
 * The gateway enables **no CORS** (`services/gateway/src/main.ts` never calls `enableCors`) and its
 * session cookies are `sameSite: 'lax'`. A browser on this app's port is a different origin, so a
 * direct call is blocked before the cookie question even arises.
 *
 * Two ways out, and the cheaper one is the wrong one: adding a cross-origin allowlist WITH
 * credentials to the gateway creates a permanently reachable CORS surface that exists only for local
 * development, and it is the combination that turns a reflected-origin mistake into session theft.
 *
 * Proxying instead keeps every browser request same-origin: no new externally reachable surface, the
 * session cookie never leaves its origin, and it matches the deployed shape (ADR 0029 — Ingress in
 * front of pods) where web and gateway already sit behind one host. The transport therefore uses a
 * RELATIVE base (`/api`) and never an absolute host — see `web/src/data/gateway/http-port.ts`.
 */

/** Where the gateway actually listens. Compose/k8s override; this default is the local dev port. */
export const GATEWAY_ORIGIN = process.env.GATEWAY_ORIGIN ?? 'http://localhost:3000';

/** The single same-origin prefix the browser talks to. Kept here so config and transport agree. */
export const API_PREFIX = '/api';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: `${API_PREFIX}/:path*`,
        destination: `${GATEWAY_ORIGIN}/:path*`,
      },
    ];
  },
};

export default nextConfig;
