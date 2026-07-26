import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { of, throwError } from 'rxjs';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { OnboardingController } from './onboarding.controller';
import { AUTH_CLIENT } from '../grpc/clients.module';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config';

/**
 * T012 (US1) — the REST onboarding edge: `activate/request` is uniform (anti-enumeration),
 * `activate/complete` sets the session on success, maps weak-password → 422 and other failures
 * → 401, and never leaks a token in the body.
 */
describe('OnboardingController (feature 010)', () => {
  let app: INestApplication;
  const auth = { requestActivation: jest.fn(), completeActivation: jest.fn() };

  const cfg: GatewayConfig = {
    ACCESS_TTL: 900,
    SESSION_TTL: 86_400,
    REMEMBER_TTL: 604_800,
    COOKIE_SECURE: false,
  } as GatewayConfig;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OnboardingController],
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

  it('POST /auth/activate/request → 200 {requested}, NO cookie (uniform)', async () => {
    auth.requestActivation.mockReturnValue(of({}));
    const res = await request(app.getHttpServer())
      .post('/auth/activate/request')
      .send({ email: 'god@example.test' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'requested' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('POST /auth/activate/complete (ok) → 200 + httpOnly access & refresh cookies', async () => {
    auth.completeActivation.mockReturnValue(
      of({ accessToken: 'atk', refreshToken: 'rtk', accessExpiresAt: '900', refreshExpiresAt: '86400' }),
    );
    const res = await request(app.getHttpServer())
      .post('/auth/activate/complete')
      .send({ email: 'god@example.test', code: 'ABC123', password: 'Passw0rd!' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
    const cookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    expect(cookies.find((c) => c.startsWith('access='))).toMatch(/HttpOnly/i);
    expect(cookies.find((c) => c.startsWith('refresh='))).toMatch(/HttpOnly/i);
    expect(JSON.stringify(res.body)).not.toContain('atk');
  });

  it('POST /auth/activate/complete (weak password) → 422 weak_password', async () => {
    auth.completeActivation.mockReturnValue(
      throwError(() => Object.assign(new Error('weak_password'), { code: GrpcStatus.INVALID_ARGUMENT })),
    );
    const res = await request(app.getHttpServer())
      .post('/auth/activate/complete')
      .send({ email: 'god@example.test', code: 'ABC123', password: 'weak' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ status: 'weak_password' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('POST /auth/activate/complete (bad code / not eligible) → 401 invalid', async () => {
    auth.completeActivation.mockReturnValue(
      throwError(() => Object.assign(new Error('invalid'), { code: GrpcStatus.UNAUTHENTICATED })),
    );
    const res = await request(app.getHttpServer())
      .post('/auth/activate/complete')
      .send({ email: 'god@example.test', code: 'WRONG9', password: 'Passw0rd!' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ status: 'invalid' });
  });
});
