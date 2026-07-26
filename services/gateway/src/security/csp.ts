import type { HelmetOptions } from 'helmet';

/**
 * Baseline Content-Security-Policy for the gateway (feature 009, FR-013 / SEC-12).
 *
 * The directives are named EXPLICITLY (analyze A2) rather than relying on helmet's shifting
 * defaults, so the security posture is auditable and stable. Tightened for the SSR/Next needs
 * when the web app lands (roadmap 8.6).
 */
export const baseCspDirectives: Record<string, string[]> = {
  defaultSrc: ["'self'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"],
  formAction: ["'self'"],
};

/** Helmet options applied app-wide at the gateway. */
export const helmetOptions: HelmetOptions = {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: baseCspDirectives,
  },
};
