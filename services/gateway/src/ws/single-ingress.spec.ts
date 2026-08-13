import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import { WsAdapter } from '@nestjs/platform-ws';
import type { INestApplication } from '@nestjs/common';
import WebSocket from 'ws';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../app.module';

// US4 / FR-009: the gateway serves REST AND WebSocket on the SAME host/port. Boots the real
// AppModule with the ws adapter, then hits both surfaces on the one ephemeral port.
describe('gateway single ingress (REST + WS)', () => {
  let app: INestApplication;
  let port: number;

  beforeAll(async () => {
    // The gRPC client registrations + Redis service + auth edge config read these at module init.
    process.env.NODE_ENV = 'test';
    process.env.GATEWAY_PORT = '3000';
    process.env.JWT_SECRET = 'test-gateway-jwt-secret-0123456789';
    process.env.REDIS_URL = 'redis://localhost:6379';
    process.env.AUTH_GRPC_TARGET = 'localhost:50051';
    process.env.USERS_GRPC_TARGET = 'localhost:50052';
    process.env.CHATS_GRPC_TARGET = 'localhost:50053';
    process.env.BRANDS_GRPC_TARGET = 'localhost:50054';
    process.env.WORKER_GRPC_TARGET = 'localhost:50055';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useWebSocketAdapter(new WsAdapter(app));
    await app.init();
    await app.listen(0);
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the REST liveness surface on the ingress port', async () => {
    const res = await request(app.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'gateway' });
  });

  /**
   * ⚠️ **This connection now carries an access cookie, and that is a deliberate behaviour change**
   * (feature 034, W4).
   *
   * Both gateways live on the same `@WebSocketGateway()` path, so one socket carries both — and
   * `RealtimeGateway` closes any connection it cannot authorize (FR-006). Before W4 the socket surface was
   * completely unauthenticated, because `AuthGuard` returns `true` for every non-HTTP context by design.
   *
   * ⇒ So this test was updated rather than the gateway loosened. Keeping an unauthenticated door open so
   * that a diagnostic ping keeps working would be exactly the trade this block exists to refuse. What the
   * test asserts is unchanged: REST and realtime answer on the SAME port.
   */
  const accessCookie = () =>
    `access=${new JwtService({}).sign(
      { sub: 'u-ingress', account_id: 'acc-ingress' },
      { secret: process.env.JWT_SECRET as string },
    )}`;

  it('upgrades a WebSocket connection on the SAME port and round-trips a message', async () => {
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: accessCookie() } });
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('timed out waiting for pong'));
      }, 4000);
      ws.on('open', () => ws.send(JSON.stringify({ event: 'ping', data: { n: 1 } })));
      ws.on('message', (raw) => {
        clearTimeout(timer);
        ws.close();
        resolve(JSON.parse(raw.toString()));
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect(reply).toMatchObject({ event: 'pong', data: { n: 1 } });
  });
});
