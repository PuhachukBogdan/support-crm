import { of } from 'rxjs';
import type { ClientGrpc } from '@nestjs/microservices';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ChannelsController } from './channels.controller';

/**
 * The 200-vs-202 answer on intake (feature 033, FR-012) — found missing by the W3 live round, 2026-08-05.
 *
 * Two comments in `channels.controller.ts` described the distinction (*"A duplicate answers 200 — see
 * below"*), and the code did not implement it: `@HttpCode(202)` covered every success, so a re-delivery
 * answered 202 like a first delivery. The live round asserted the documented behaviour and failed on it.
 *
 * ⚠️ Nothing was broken for a provider — both are successes and FR-012's real requirement (never answer a
 * duplicate with an error) held throughout. What was wrong is subtler and worth the fix: the file DESCRIBED
 * a behaviour it did not have, and the next person to rely on the description would have been the one to
 * discover that.
 *
 * ── What this can and cannot check ──────────────────────────────────────────────────────────────
 * ⚠️ Constructing a controller with `new` exercises no decorator (`gotchas/decorators-are-invisible-to-
 * unit-tests`), so the 202 DEFAULT is not observable here — only the deliberate lowering to 200 is. The
 * default is asserted where it is real, over HTTP, in `deploy/local/live-w3.sh`.
 */
function controllerFor(outcome: Record<string, unknown>): {
  controller: ChannelsController;
  res: Response;
  statuses: number[];
} {
  const client = {
    getService: () => ({ AcceptChannelDelivery: () => of(outcome) }),
  } as unknown as ClientGrpc;
  const controller = new ChannelsController(client);
  controller.onModuleInit();

  const statuses: number[] = [];
  const res = { status: (code: number) => statuses.push(code) } as unknown as Response;
  return { controller, res, statuses };
}

const req = { rawBody: Buffer.from('{"event_id":"evt-1"}'), headers: {} } as unknown as RawBodyRequest<Request>;

describe('intake answers a duplicate differently from a first delivery', () => {
  it('lowers a duplicate to 200 — nothing was created this time', async () => {
    const { controller, res, statuses } = controllerFor({
      duplicate: true,
      conversationId: 'conv-1',
    });
    const body = await controller.inbound('stand-api-brand1', req, res);
    expect(statuses).toEqual([200]);
    expect(body).toEqual({ status: 'duplicate', conversationId: 'conv-1' });
  });

  /**
   * The control: a first delivery must NOT touch the status, or the decorator's 202 is silently replaced
   * and every provider sees 200 — which is the mirror of the defect and just as invisible.
   */
  it('leaves a first delivery alone, so the route keeps its 202', async () => {
    const { controller, res, statuses } = controllerFor({
      duplicate: false,
      conversationId: 'conv-2',
    });
    const body = await controller.inbound('stand-api-brand1', req, res);
    expect(statuses).toEqual([]);
    expect(body).toEqual({ status: 'accepted', conversationId: 'conv-2' });
  });
});
