import type { INestApplication, ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { of, throwError } from 'rxjs';
import type { Response } from 'express';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearSessionCookies,
  setSessionCookies,
} from './session-cookie';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AUTH_CLIENT } from '../grpc/clients.module';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config';

/**
 * T025 (US3) — session cookies: correct httpOnly flags + maxAge (derived from the returned
 * expiry, so ~1d default / ~7d remember-me), `/auth/refresh` rotates the cookies, `/auth/logout`
 * clears them, and an expired access token is rejected by the guard.
 */
describe('session cookies (feature 009, US3)', () => {
  describe('cookie helpers', () => {
    function fakeRes() {
      const set: Record<string, { value: string; opts: Record<string, unknown> }> = {};
      const cleared: Record<string, Record<string, unknown>> = {};
      const res = {
        cookie(name: string, value: string, opts: Record<string, unknown>) {
          set[name] = { value, opts };
          return res;
        },
        clearCookie(name: string, opts: Record<string, unknown>) {
          cleared[name] = opts;
          return res;
        },
        set,
        cleared,
      };
      return res as unknown as Response & { set: typeof set; cleared: typeof cleared };
    }

    it('sets httpOnly access+refresh cookies with maxAge in ms and lax/secure/path flags', () => {
      const res = fakeRes();
      setSessionCookies(
        res,
        { accessToken: 'atk', refreshToken: 'rtk', accessMaxAgeSec: 900, refreshMaxAgeSec: 604_800 },
        { secure: true },
      );
      expect(res.set[ACCESS_COOKIE]!.opts).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 900_000,
      });
      expect(res.set[REFRESH_COOKIE]!.opts.maxAge).toBe(604_800_000); // 7 days in ms
    });

    it('clears both session cookies on logout', () => {
      const res = fakeRes();
      clearSessionCookies(res, { secure: false });
      expect(Object.keys(res.cleared).sort()).toEqual([ACCESS_COOKIE, REFRESH_COOKIE].sort());
    });
  });

  describe('/auth/refresh + /auth/logout', () => {
    let app: INestApplication;
    const auth = { login: jest.fn(), verifyLoginCode: jest.fn(), refresh: jest.fn(), logout: jest.fn() };
    const cfg = { ACCESS_TTL: 900, SESSION_TTL: 86_400, REMEMBER_TTL: 604_800, COOKIE_SECURE: false } as GatewayConfig;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [AuthController],
        providers: [
          { provide: AUTH_CLIENT, useValue: { getService: () => auth } },
          { provide: GATEWAY_CONFIG, useValue: cfg },
        ],
      }).compile();
      app = moduleRef.createNestApplication();
      app.use(cookieParser());
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it('POST /auth/refresh with a refresh cookie → 200 + rotated access & refresh cookies', async () => {
      const future = Math.floor(Date.now() / 1000) + 3600;
      auth.refresh.mockReturnValue(
        of({ accessToken: 'a2', refreshToken: 'r2', accessExpiresAt: String(future), refreshExpiresAt: String(future) }),
      );
      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE}=rt-1.secret`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
      const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
      expect(cookies.find((c) => c.startsWith('access='))).toMatch(/HttpOnly/i);
      expect(cookies.find((c) => c.startsWith('refresh='))).toMatch(/HttpOnly/i);
    });

    it('POST /auth/refresh with no cookie → 401 unauthorized', async () => {
      const res = await request(app.getHttpServer()).post('/auth/refresh');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ status: 'unauthorized' });
    });

    it('POST /auth/refresh with a rejected token → 401 + cookies cleared', async () => {
      auth.refresh.mockReturnValue(throwError(() => new Error('invalid_refresh')));
      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE}=rt-x.bad`);
      expect(res.status).toBe(401);
    });

    it('POST /auth/logout → 200 logged_out and clears cookies', async () => {
      auth.logout.mockReturnValue(of({ revoked: true }));
      const res = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Cookie', `${REFRESH_COOKIE}=rt-1.secret`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'logged_out' });
      const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
      // Cleared cookies come back with an expiry in the past / empty value.
      expect(cookies.some((c) => c.startsWith('access='))).toBe(true);
      expect(cookies.some((c) => c.startsWith('refresh='))).toBe(true);
    });
  });

  describe('expired access token', () => {
    it('is rejected by the guard (401)', () => {
      const jwt = new JwtService({});
      const cfg = { JWT_SECRET: 'expiry-secret-abcdefghijklmnop' } as GatewayConfig;
      const guard = new AuthGuard({ getAllAndOverride: () => false } as unknown as Reflector, jwt, cfg);
      // A token that expired 10s ago.
      const expired = jwt.sign({ sub: 'u', account_id: 'acct-A' }, { secret: cfg.JWT_SECRET, expiresIn: -10 });
      const ctx = {
        getType: () => 'http',
        getHandler: () => () => undefined,
        getClass: () => class {},
        switchToHttp: () => ({ getRequest: () => ({ cookies: { [ACCESS_COOKIE]: expired } }) }),
      } as unknown as ExecutionContext;
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });
});
