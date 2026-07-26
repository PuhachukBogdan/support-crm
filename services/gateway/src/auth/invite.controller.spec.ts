import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { of } from 'rxjs';
import { InviteController } from './invite.controller';
import { AUTH_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from './auth.guard';

/**
 * T019 (US2) — the invite edge maps the gRPC status to 201/403/429 and forwards the caller's
 * identity from the VALIDATED claims (`req.claims`), never from the body.
 */
describe('InviteController (feature 010)', () => {
  let app: INestApplication;
  const auth = { createInvitation: jest.fn() };
  let claims: RequestClaims | undefined;
  let seen: { inviterUserId: string; inviterRoles: string[]; email: string; roleKey: string } | undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InviteController],
      providers: [{ provide: AUTH_CLIENT, useValue: { getService: () => auth } }],
    }).compile();
    app = moduleRef.createNestApplication();
    // Stand in for the global AuthGuard: attach validated claims to the request.
    app.use((req: { claims?: RequestClaims }, _res: unknown, next: () => void) => {
      req.claims = claims;
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    claims = { userId: 'sa-1', accountId: 'acct-1', roles: ['super_admin'] };
    auth.createInvitation.mockImplementation((data) => {
      seen = data;
      return of({ status: 'INVITATION_CREATED', invitationId: 'inv-1' });
    });
  });

  it('POST /auth/invites (created) → 201 and forwards claims (not body) as inviter', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/invites')
      .send({ email: 'new@example.test', role: 'admin', inviterRoles: ['attacker'] });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: 'created', invitationId: 'inv-1' });
    // Inviter identity comes from claims, NOT the body's injected inviterRoles.
    expect(seen).toMatchObject({ inviterUserId: 'sa-1', inviterRoles: ['super_admin'], email: 'new@example.test', roleKey: 'admin' });
  });

  it('POST /auth/invites (hierarchy violation) → 403', async () => {
    auth.createInvitation.mockReturnValue(of({ status: 'INVITATION_FORBIDDEN', invitationId: '' }));
    const res = await request(app.getHttpServer())
      .post('/auth/invites')
      .send({ email: 'x@example.test', role: 'super_admin' });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ status: 'forbidden' });
  });

  it('POST /auth/invites (rate limited) → 429', async () => {
    auth.createInvitation.mockReturnValue(of({ status: 'INVITATION_RATE_LIMITED', invitationId: '' }));
    const res = await request(app.getHttpServer())
      .post('/auth/invites')
      .send({ email: 'x@example.test', role: 'manager' });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ status: 'rate_limited' });
  });

  it('POST /auth/invites with no claims → 401 (fail closed)', async () => {
    claims = undefined;
    const res = await request(app.getHttpServer())
      .post('/auth/invites')
      .send({ email: 'x@example.test', role: 'manager' });
    expect(res.status).toBe(401);
  });
});
