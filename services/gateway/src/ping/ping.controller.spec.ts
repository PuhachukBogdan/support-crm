import { HttpException } from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { PingController } from './ping.controller';

// US3 / FR-007, FR-008: success maps the DOWNSTREAM response to the REST body; a downstream
// gRPC error becomes a clean 503 (no crash). Compose-independent (mocked ClientGrpc).
function makeController(pingImpl: (req: { message: string }) => unknown): PingController {
  const client = { getService: () => ({ ping: pingImpl }) } as unknown as ClientGrpc;
  const controller = new PingController(client);
  controller.onModuleInit();
  return controller;
}

describe('gateway PingController', () => {
  it('returns the downstream response tagged servedBy=users on success', async () => {
    const controller = makeController(() => of({ message: 'hi', servedAt: '2026-07-16T00:00:00.000Z' }));
    await expect(controller.ping('hi')).resolves.toEqual({
      message: 'hi',
      servedAt: '2026-07-16T00:00:00.000Z',
      servedBy: 'users',
    });
  });

  it('throws a 503 (never crashes) when the downstream is unavailable', async () => {
    const controller = makeController(() => throwError(() => new Error('unavailable')));
    await expect(controller.ping('hi')).rejects.toBeInstanceOf(HttpException);
    try {
      await controller.ping('hi');
    } catch (e) {
      const ex = e as HttpException;
      expect(ex.getStatus()).toBe(503);
      expect(ex.getResponse()).toMatchObject({ status: 'degraded', service: 'users' });
    }
  });
});
