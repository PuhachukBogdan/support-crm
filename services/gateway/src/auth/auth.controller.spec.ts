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
