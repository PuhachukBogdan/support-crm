import { Reflector } from '@nestjs/core';
import { type ClientGrpc } from '@nestjs/microservices';
import { of } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { FeedController } from './feed.controller';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';

function makeCtrl() {
  const getPlayerFeed = jest.fn().mockReturnValue(of({ conversations: [], nextPageToken: '' }));
  const client = {
    getService: () => ({ getPlayerFeed }),
  } as unknown as ClientGrpc;
  const ctrl = new FeedController(client);
  ctrl.onModuleInit();
  return { ctrl, getPlayerFeed };
}

const req = () =>
  ({
    claims: { accountId: 'acc-1', userId: 'op-1', roles: ['support_agent'] },
    effective: { permissionKeys: ['crm.inbox.view'] },
  }) as never;

describe('FeedController (gateway proxy, US3)', () => {
  it('proxies the player feed with x-actor metadata (identity from claims)', async () => {
    const { ctrl, getPlayerFeed } = makeCtrl();
    await ctrl.feed('p1', { brandId: 'brand-a' }, req());
    const [arg, md] = getPlayerFeed.mock.calls[0] as [
      { playerId: string; brandId: string },
      Metadata,
    ];
    expect(arg.playerId).toBe('p1');
    // Feature 020: the brand travels too — without it the platform id names two customers, and the
    // owning service refuses rather than merging them.
    expect(arg.brandId).toBe('brand-a');
    // The actor context still reaches the service; the brand-scope header that used to be asserted
    // here is gone with the concept (ADR 0038 §1).
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
    expect(md.get('x-actor-brands')).toHaveLength(0);
  });

  it('declares crm.inbox.view on the feed route', () => {
    const reflector = new Reflector();
    expect(reflector.get(REQUIRED_PERMISSION_KEY, FeedController.prototype.feed)).toBe(
      'crm.inbox.view',
    );
  });
});
