import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { of, throwError } from 'rxjs';
import { AuthController } from './auth.controller';
import { AUTH_CLIENT } from '../grpc/clients.module';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config';

/**
 * T014 (US1) — the REST session edge: `/auth/login` returns the challenge (no cookie),
 * `/auth/verify` sets httpOnly access+refresh cookies, failures are generic, and there is
 * NO public self-registration route (FR-002 / analyze C1).
 */
describe('AuthController (feature 009)', () => {
  let app: INestApplication;
  const auth = { login: jest.fn(), verifyLoginCode: jest.fn() };

  const cfg: GatewayConfig = {
    ACCESS_TTL: 900,
    SESSION_TTL: 86_400,
    REMEMBER_TTL: 604_800,
    COOKIE_SECURE: false,
  } as GatewayConfig;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AUTH_CLIENT, useValue: { getService: () => auth } },
        { provide: GATEWAY_CONFIG, useValue: cfg },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /auth/login (code sent) → 200 code_sent, NO cookie set', async () => {
    auth.login.mockReturnValue(of({ status: 'CODE_SENT', challengeId: 'chal-1', codeExpiresAt: '1700' }));
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'agent@example.test', password: 'pw' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'code_sent', challengeId: 'chal-1', codeExpiresAt: 1700 });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('POST /auth/login (bad credentials) → 401 invalid_credentials (generic, no cookie)', async () => {
    auth.login.mockReturnValue(of({ status: 'INVALID_CREDENTIALS', challengeId: '', codeExpiresAt: '0' }));
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ghost@example.test', password: 'pw' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ status: 'invalid_credentials' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('POST /auth/login (locked) → 423 locked', async () => {
    auth.login.mockReturnValue(of({ status: 'LOCKED', challengeId: '', codeExpiresAt: '0' }));
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'agent@example.test', password: 'pw' });
    expect(res.status).toBe(423);
    expect(res.body).toEqual({ status: 'locked' });
  });

  it('POST /auth/verify (valid code) → 200 ok + httpOnly access & refresh cookies', async () => {
    auth.verifyLoginCode.mockReturnValue(
      of({ accessToken: 'atk', refreshToken: 'rtk', accessExpiresAt: '1', refreshExpiresAt: '2' }),
    );
    const res = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ challengeId: 'chal-1', code: 'ABC123', rememberMe: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const access = cookies.find((c) => c.startsWith('access='));
    const refresh = cookies.find((c) => c.startsWith('refresh='));
    expect(access).toMatch(/HttpOnly/i);
    expect(refresh).toMatch(/HttpOnly/i);
    // The token itself is opaque in transit but never appears in the JSON body.
    expect(JSON.stringify(res.body)).not.toContain('atk');
  });

  it('POST /auth/verify (bad code) → 401 invalid_code, cookies cleared', async () => {
    auth.verifyLoginCode.mockReturnValue(throwError(() => new Error('invalid_code')));
    const res = await request(app.getHttpServer())
      .post('/auth/verify')
      .send({ challengeId: 'chal-1', code: 'WRONG9' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ status: 'invalid_code' });
  });

  it('FR-002 — there is NO public self-registration route on the auth surface', async () => {
    const register = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'x@example.test', password: 'pw' });
    expect(register.status).toBe(404);
    const signup = await request(app.getHttpServer()).post('/auth/signup').send({});
    expect(signup.status).toBe(404);
  });
});

/**
 * Feature 029 — `/auth/me` carries the effective permission keys, and is ANNOTATED so it gets them.
 *
 * ⚠️ The annotation is the whole risk. The guard fills `req.effective` only for routes carrying
 * permission metadata, so an un-annotated `/auth/me` answers `permissionKeys: []` for everybody —
 * indistinguishable from "this person may do nothing". The shell would then render an empty rail for
 * an admin and the cause would look like a permissions bug in `auth`, not a missing decorator.
 * Feature 016 hit exactly this on `GET /uploads/:id`, live, with both guards' unit specs green.
 */
describe('*** GET /auth/me exposes the resolved permission keys (feature 029) ***', () => {
  const { Reflector } = jest.requireActual<typeof import('@nestjs/core')>('@nestjs/core');
  const { RESOLVE_PERMISSIONS_KEY } = jest.requireActual<
    typeof import('../security/requires-permission.decorator')
  >('../security/requires-permission.decorator');

  it('the route is marked @ResolvesPermissions — without it the set is empty for everyone', () => {
    const reflector = new Reflector();
    expect(reflector.get(RESOLVE_PERMISSIONS_KEY, AuthController.prototype.me)).toBe(true);
  });

  it('returns the keys the guard resolved onto the request', () => {
    const ctrl = new AuthController(
      { getService: () => ({}) } as never,
      {} as never,
    );
    const res = ctrl.me({
      claims: { userId: 'u1', accountId: 'acc-1', roles: ['support_agent'] },
      effective: { permissionKeys: ['crm.inbox.view'] },
    } as never);
    expect(res).toMatchObject({
      userId: 'u1',
      accountId: 'acc-1',
      roles: ['support_agent'],
      permissionKeys: ['crm.inbox.view'],
    });
  });

  it('answers an EMPTY list rather than undefined when nothing resolved', () => {
    // Deny-by-default at the rendering layer too: a missing list must not read as "unknown, so allow".
    const ctrl = new AuthController({ getService: () => ({}) } as never, {} as never);
    const res = ctrl.me({ claims: { userId: 'u1', accountId: 'a' } } as never) as {
      permissionKeys: string[];
    };
    expect(res.permissionKeys).toEqual([]);
  });
});
