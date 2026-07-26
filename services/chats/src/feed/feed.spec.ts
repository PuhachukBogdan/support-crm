import { Metadata } from '@grpc/grpc-js';
import type { PrismaService } from '../prisma.service';
import { ConversationRepository } from '../conversation/conversation.repository';
import { FeedReadController } from './feed.grpc.controller';

function conv(id: string, brand: string) {
  return {
    id,
    brand_id: brand,
    player_id: 'p1',
    status: 'open',
    priority: null,
    assignee_operator_id: null,
    channel: null,
    created_at: new Date(`2026-07-22T10:0${id.length}:00.000Z`),
    updated_at: new Date(`2026-07-22T11:0${id.length}:00.000Z`),
  };
}

/** Fake that applies player + brand where-filters so the test proves the union & isolation. */
function fakePrisma(store: ReturnType<typeof conv>[]) {
  const findMany = jest.fn((args: { where: Record<string, unknown> }) => {
    const w = args.where;
    let rows = store;
    if (w.player_id) rows = rows.filter((r) => r.player_id === w.player_id);
    const b = w.brand_id as { in?: string[] } | undefined;
    if (b?.in) rows = rows.filter((r) => b.in!.includes(r.brand_id));
    return Promise.resolve(rows);
  });
  const forAccount = jest.fn().mockReturnValue({ conversation: { findMany } });
  return { prisma: { forAccount } as unknown as PrismaService, findMany, forAccount };
}

function md(accountId = 'acc-1', brands?: string[]): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'op-1');
  if (brands) m.set('x-actor-brands', brands.join(','));
  return m;
}

describe('FeedReadController.getPlayerFeed (US3)', () => {
  it('merges a player across the brands they span within the account (brand-union)', async () => {
    const { prisma } = fakePrisma([conv('a', 'brand-a'), conv('bb', 'brand-b')]);
    const ctrl = new FeedReadController(new ConversationRepository(prisma));
    const res = await ctrl.getPlayerFeed({ playerId: 'p1' }, md('acc-1', ['brand-a', 'brand-b']));
    expect(res.conversations.map((c) => c.brandId).sort()).toEqual(['brand-a', 'brand-b']);
  });

  it('scopes to the caller account (never crosses accounts, Principle I)', async () => {
    const { prisma, forAccount } = fakePrisma([conv('a', 'brand-a')]);
    const ctrl = new FeedReadController(new ConversationRepository(prisma));
    await ctrl.getPlayerFeed({ playerId: 'p1' }, md('acc-1', ['brand-a']));
    expect(forAccount).toHaveBeenCalledWith('acc-1'); // isolation is via forAccount, not a where the caller controls
  });

  it('omits a brand the caller may not serve (R3)', async () => {
    const { prisma } = fakePrisma([conv('a', 'brand-a'), conv('bb', 'brand-b')]);
    const ctrl = new FeedReadController(new ConversationRepository(prisma));
    const res = await ctrl.getPlayerFeed({ playerId: 'p1' }, md('acc-1', ['brand-a']));
    expect(res.conversations.map((c) => c.brandId)).toEqual(['brand-a']);
  });

  it('returns an empty feed for an unknown/empty player (no existence disclosure)', async () => {
    const { prisma, findMany } = fakePrisma([conv('a', 'brand-a')]);
    const ctrl = new FeedReadController(new ConversationRepository(prisma));
    const res = await ctrl.getPlayerFeed({ playerId: '' }, md('acc-1', ['brand-a']));
    expect(res.conversations).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
