import type { Response } from 'express';

/**
 * httpOnly session cookies (feature 009, contracts/gateway-rest.md). The gateway is the only
 * place tokens touch a cookie; client scripts can never read them (httpOnly — closes the
 * XSS→token-theft path, SEC-11). `Secure` is on except for explicit local plain-HTTP dev.
 */
export const ACCESS_COOKIE = 'access';
export const REFRESH_COOKIE = 'refresh';

export interface SessionCookieOptions {
  /** Production: true (HTTPS only). Local plain-HTTP dev may set false via COOKIE_SECURE. */
  secure: boolean;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  /** Cookie lifetimes in SECONDS (access ≈ ACCESS_TTL; refresh = session lifetime). */
  accessMaxAgeSec: number;
  refreshMaxAgeSec: number;
}

function baseCookie(opts: SessionCookieOptions) {
  return {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax' as const,
    path: '/',
  };
}

/** Set both session cookies on the response (login / refresh). */
export function setSessionCookies(
  res: Response,
  tokens: SessionTokens,
  opts: SessionCookieOptions,
): void {
  const base = baseCookie(opts);
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...base,
    maxAge: tokens.accessMaxAgeSec * 1000,
  });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...base,
    maxAge: tokens.refreshMaxAgeSec * 1000,
  });
}

/** Clear both session cookies (logout / failed refresh). */
export function clearSessionCookies(res: Response, opts: SessionCookieOptions): void {
  const base = baseCookie(opts);
  res.clearCookie(ACCESS_COOKIE, base);
  res.clearCookie(REFRESH_COOKIE, base);
}
