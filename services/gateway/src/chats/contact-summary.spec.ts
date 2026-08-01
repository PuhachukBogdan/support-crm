import { Reflector } from '@nestjs/core';
import { type ClientGrpc } from '@nestjs/microservices';
import { of } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { FeedController } from './feed.controller';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';

function makeCtrl() {
  const getPlayerContactSummary = jest.fn().mockReturnValue(
    of({
      lastInboundAt: '2026-07-20T09:00:00.000Z',
      lastOutboundAt: '',
      lastContactAt: '2026-07-20T09:00:00.000Z',
      conversationCount: 1,
      countsByStatus: [],
      channels: [],
    }),
  );
  const getPlayerFeed = jest.fn().mockReturnValue(of({ conversations: [], nextPageToken: '' }));
  const client = {
    getService: () => ({ getPlayerFeed, getPlayerContactSummary }),
  } as unknown as ClientGrpc;
  const ctrl = new FeedController(client);
  ctrl.onModuleInit();
  return { ctrl, getPlayerContactSummary };
}

const req = (permissionKeys = ['crm.inbox.view']) =>
  ({
    claims: { accountId: 'acc-1', userId: 'op-1', roles: ['support_agent'] },
    effective: { permissionKeys },
  }) as never;

/**
 * Feature 022 (roadmap 4.13), T027 — **the contact-summary edge.**
 *
 * ⚠️ Why the permission-metadata assertion is the important one here. Feature 016's single live-only
 * defect was a gateway route that carried NO permission metadata: `req.effective` is populated only for
 * routes that declare a required key, so the edge forwarded an EMPTY `x-actor-permissions` and the owning
 * service — correctly — refused every request. Both tiers were individually right; the wire between them
 * was not, and no offline test at either end could see it. That has now happened four times in this
 * product (4.9, 5.1, 5.2, 5.6), which is why this is asserted structurally rather than trusted.
 */
describe('FeedController.contactSummary (gateway proxy, feature 022)', () => {
  it('proxies the summary with the player, the brand and the actor metadata', async () => {
    const { ctrl, getPlayerContactSummary } = makeCtrl();
    await ctrl.contactSummary('p1', { brandId: 'brand-a' }, req());
    const [arg, md] = getPlayerContactSummary.mock.calls[0] as [
      { playerId: string; brandId: string },
      Metadata,
    ];
    expect(arg).toEqual({ playerId: 'p1', brandId: 'brand-a' });
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
    expect(md.get('x-actor-user-id')[0]).toBe('op-1');
  });

  it('FORWARDS the caller’s permission set (the feature-016 wire defect, asserted not assumed)', () => {
    // The mechanism: `@RequiresPermission` is what makes the guard resolve `req.effective` at all. If the
    // decorator were dropped from the route, this assertion is what would fail — before a live run does.
    const reflector = new Reflector();
    expect(
      reflector.get(REQUIRED_PERMISSION_KEY, FeedController.prototype.contactSummary),
    ).toBe('crm.inbox.view');
  });

  it('the actual metadata carries the permission keys, not an empty header', async () => {
    const { ctrl, getPlayerContactSummary } = makeCtrl();
    await ctrl.contactSummary('p1', { brandId: 'brand-a' }, req(['crm.inbox.view']));
    const [, md] = getPlayerContactSummary.mock.calls[0] as [unknown, Metadata];
    expect(md.get('x-actor-permissions')[0]).toContain('crm.inbox.view');
  });

  it('sends NO brand when the caller sent none — it does not invent an identity', async () => {
    // The owning service refuses a summary with no brand, because a platform id alone names two
    // customers (feature 020). An edge that defaulted the brand would turn that refusal into a wrong
    // answer, which is the 5.1 defect's shape (a brand the caller never asked for).
    const { ctrl, getPlayerContactSummary } = makeCtrl();
    await ctrl.contactSummary('p1', {}, req());
    const [arg] = getPlayerContactSummary.mock.calls[0] as [{ brandId: string }];
    expect(arg.brandId).toBe('');
  });

  /**
   * ⚠️ **There is deliberately NO "carries no brand-scope header" assertion here**, and the reason is a
   * standing guard rather than an oversight.
   *
   * `tests/data-model/no-brand-scope-remnants.spec.ts` bans the token `x-actor-brands` from the source and
   * exempts exactly two files — the specs that prove the metadata builder emits no such header. Asserting
   * it again per route would need a third exemption, then a fourth, and that guard's own note says plainly
   * that a growing exemption list is how a guard gets widened into uselessness.
   *
   * The property belongs to `buildActorMetadata`, which every route here uses, and it is asserted where the
   * builder is: `actor-metadata.spec.ts`. One place, one proof.
   */

  it('uses the SAME permission key as the feed — the same facts in aggregate', () => {
    const reflector = new Reflector();
    const feedKey = reflector.get(REQUIRED_PERMISSION_KEY, FeedController.prototype.feed);
    const summaryKey = reflector.get(
      REQUIRED_PERMISSION_KEY,
      FeedController.prototype.contactSummary,
    );
    // A new key here would have to be granted to everyone who already holds the old one — a role-matrix
    // change with no security gain (spec assumption 8).
    expect(summaryKey).toBe(feedKey);
  });
});
