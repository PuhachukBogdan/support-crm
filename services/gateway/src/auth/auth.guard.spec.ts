import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard, type RequestClaims } from './auth.guard';
import { ACCESS_COOKIE } from './session-cookie';
import type { GatewayConfig } from '../config';

/**
 * T014 (US1) — the global guard admits a request only with a valid `access` JWT, attaches the
 * claims, and fails closed (401) otherwise. `@Public()` routes and non-HTTP contexts pass.
 */
describe('AuthGuard (feature 009)', () => {
  const jwt = new JwtService({});
  const cfg = { JWT_SECRET: 'guard-secret-abcdefghijklmnop-0123' } as GatewayConfig;

  const guardWith = (isPublic: boolean) =>
    new AuthGuard({ getAllAndOverride: () => isPublic } as unknown as Reflector, jwt, cfg);

  function httpCtx(req: unknown): ExecutionContext {
    return {
      getType: () => 'http',
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  const sign = (claims: object) =>
    jwt.sign(claims, { secret: cfg.JWT_SECRET, expiresIn: 900 });

  it('passes a request carrying a valid access cookie and attaches claims', () => {
    const token = sign({ sub: 'user-1', account_id: 'acct-A', roles: ['agent'] });
    const req: { cookies: Record<string, string>; claims?: RequestClaims } = {
      cookies: { [ACCESS_COOKIE]: token },
    };
    expect(guardWith(false).canActivate(httpCtx(req))).toBe(true);
    expect(req.claims).toEqual({ userId: 'user-1', accountId: 'acct-A', roles: ['agent'] });
  });

  it('rejects a request with no access cookie (401)', () => {
    expect(() => guardWith(false).canActivate(httpCtx({ cookies: {} }))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a request with an invalid/tampered token (401)', () => {
    expect(() =>
      guardWith(false).canActivate(httpCtx({ cookies: { [ACCESS_COOKIE]: 'garbage.token' } })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a token signed with a different secret (401)', () => {
    const alien = jwt.sign({ sub: 'u', account_id: 'acct-B' }, { secret: 'other-secret-999999', expiresIn: 900 });
    expect(() =>
      guardWith(false).canActivate(httpCtx({ cookies: { [ACCESS_COOKIE]: alien } })),
    ).toThrow(UnauthorizedException);
  });

  it('lets a @Public() route through even with no cookie', () => {
    expect(guardWith(true).canActivate(httpCtx({ cookies: {} }))).toBe(true);
  });

  it('passes non-HTTP contexts through (WebSocket out of scope here)', () => {
    const wsCtx = { getType: () => 'ws' } as unknown as ExecutionContext;
    expect(guardWith(false).canActivate(wsCtx)).toBe(true);
  });
});
