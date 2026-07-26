import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { of, throwError } from 'rxjs';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { RegistrationController } from './registration.controller';
import { AUTH_CLIENT } from '../grpc/clients.module';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config';

/**
 * T025 (US3) — the registration edge: `register/start` returns code_sent/401, `register/complete`
 * sets the session on success, maps weak-password → 422 and other failures → 401.
 */
describe('RegistrationController (feature 010)', () => {
  let app: INestApplication;
  const auth = { startRegistration: jest.fn(), completeRegistration: jest.fn() };
  const cfg: GatewayConfig = { COOKIE_SECURE: false } as GatewayConfig;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RegistrationController],
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

  it('POST /auth/register/start (valid) → 200 code_sent', async () => {
    auth.startRegistration.mockReturnValue(of({ status: 'REGISTRATION_CODE_SENT', codeExpiresAt: '1700' }));
    const res = await request(app.getHttpServer())
      .post('/auth/register/start')
      .send({ token: 'inv-1.secret', email: 'a@example.test' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'code_sent', codeExpiresAt: 1700 });
  });

  it('POST /auth/register/start (bad token) → 401 invalid', async () => {
    auth.startRegistration.mockReturnValue(of({ status: 'REGISTRATION_INVALID', codeExpiresAt: '0' }));
    const res = await request(app.getHttpServer())
      .post('/auth/register/start')
      .send({ token: 'bad', email: 'a@example.test' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ status: 'invalid' });
  });

  it('POST /auth/register/complete (ok) → 200 + httpOnly cookies', async () => {
    auth.completeRegistration.mockReturnValue(
      of({ accessToken: 'atk', refreshToken: 'rtk', accessExpiresAt: '900', refreshExpiresAt: '86400' }),
    );
    const res = await request(app.getHttpServer())
      .post('/auth/register/complete')
      .send({ token: 'inv-1.secret', email: 'a@example.test', code: 'ABC123', password: 'Passw0rd!' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.find((c) => c.startsWith('access='))).toMatch(/HttpOnly/i);
    expect(cookies.find((c) => c.startsWith('refresh='))).toMatch(/HttpOnly/i);
    expect(JSON.stringify(res.body)).not.toContain('atk');
  });

  it('POST /auth/register/complete (weak password) → 422', async () => {
    auth.completeRegistration.mockReturnValue(
      throwError(() => Object.assign(new Error('weak_password'), { code: GrpcStatus.INVALID_ARGUMENT })),
    );
    const res = await request(app.getHttpServer())
      .post('/auth/register/complete')
      .send({ token: 'inv-1.secret', email: 'a@example.test', code: 'ABC123', password: 'weak' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ status: 'weak_password' });
  });

  it('POST /auth/register/complete (bad code) → 401 invalid', async () => {
    auth.completeRegistration.mockReturnValue(
      throwError(() => Object.assign(new Error('invalid'), { code: GrpcStatus.UNAUTHENTICATED })),
    );
    const res = await request(app.getHttpServer())
      .post('/auth/register/complete')
      .send({ token: 'inv-1.secret', email: 'a@example.test', code: 'WRONG9', password: 'Passw0rd!' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ status: 'invalid' });
  });
});
