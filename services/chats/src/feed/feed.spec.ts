import { Metadata } from '@grpc/grpc-js';
import type { PrismaService } from '../prisma.service';
import { ConversationRepository } from '../conversation/conversation.repository';
import { FeedReadController } from './feed.grpc.controller';
import type { PersonMembersClient } from '../person/person-members.client';
import { TransitionRecorder } from '../transition/transition.recorder';

/**
 * ⚠️ **This spec used to certify the defect.** Its first test read *"merges a player across the brands
 * they span within the account (brand-union)"*, and its Track B counterpart (roadmap 4.3) proved the
 * same thing live. The merge did happen — and that is exactly what was wrong.
 *
 * GR8's `player_id` is unique only WITHIN a brand, so the same value under two brands is routinely two
 * different human beings. Merging their feeds showed an agent **another customer's conversations**.
 * Neither test could have caught it: both verified the mechanism worked, and correctness depended on a
 * fact about GR8 that no document held at the time (feature 020, ADR 0038 §3).
 *
 * The tests below assert the repaired behaviour; the old expectations are quoted where they stood.
 */

function conv(id: string, brand: string, player = 'p1') {
  return {
    id,
    brand_id: brand,
    player_id: player,
    status: 'open',
    priority: null,
    assignee_operator_id: null,
    channel: null,
    created_at: new Date(`2026-07-22T10:0${id.length}:00.000Z`),
    updated_at: new Date(`2026-07-22T11:0${id.length}:00.000Z`),
  };
}

/** Fake that applies player + brand where-filters, so the test proves the scoping and not the fake. */
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

function md(accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'op-1');
  return m;
}

/**
 * Feature 022 gave this controller a second dependency (the person-membership client, for `GetPersonFeed`).
 * A NAMED stub that THROWS, not a permissive mock: the PLAYER feed already holds the full identity and
 * must never ask `users` who a person is. If a future edit made it consult membership, these tests fail
 * loudly rather than passing against a fake that answered anyway.
 */
function noMembers() {
  return {
    membersOf: () => {
      throw new Error('the player feed must not resolve person membership');
    },
  } as unknown as PersonMembersClient;
}

const ctrlFor = (prisma: PrismaService) =>
  new FeedReadController(new ConversationRepository(prisma, new TransitionRecorder()), noMembers());

describe('FeedReadController.getPlayerFeed — ONE brand-scoped player (feature 020)', () => {
  it('*** the same platform id under another brand does NOT appear in this feed ***', async () => {
    // Was: `expect(...).toEqual(['brand-a', 'brand-b'])` — "brand-union". Those two rows are two
    // different customers whenever the platform reuses an id, and this is the assertion that says so.
    const { prisma } = fakePrisma([conv('a', 'brand-a'), conv('bb', 'brand-b')]);
    const res = await ctrlFor(prisma).getPlayerFeed(
      { playerId: 'p1', brandId: 'brand-a' },
      md('acc-1'),
    );
    expect(res.conversations.map((c) => c.brandId)).toEqual(['brand-a']);
  });

  it('and the other brand gets its own feed, with only its own conversations', async () => {
    const { prisma } = fakePrisma([conv('a', 'brand-a'), conv('bb', 'brand-b')]);
    const res = await ctrlFor(prisma).getPlayerFeed(
      { playerId: 'p1', brandId: 'brand-b' },
      md('acc-1'),
    );
    expect(res.conversations.map((c) => c.brandId)).toEqual(['brand-b']);
  });

  it('a feed requested WITHOUT a brand is refused, never merged', async () => {
    // The platform id names two customers, so there is no correct feed to return — only a lucky one.
    const { prisma, findMany } = fakePrisma([conv('a', 'brand-a')]);
    await expect(
      ctrlFor(prisma).getPlayerFeed({ playerId: 'p1' }, md('acc-1')),
    ).rejects.toMatchObject({ error: { code: 3 } });
    // Refused on shape, before any read — the answer cannot depend on what happens to be stored.
    expect(findMany).not.toHaveBeenCalled();
  });

  it('an EMPTY brand counts as absent, not as "any brand"', async () => {
    const { prisma, findMany } = fakePrisma([conv('a', 'brand-a')]);
    await expect(
      ctrlFor(prisma).getPlayerFeed({ playerId: 'p1', brandId: '' }, md('acc-1')),
    ).rejects.toMatchObject({ error: { code: 3 } });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('scopes to the caller account (never crosses accounts, Principle I)', async () => {
    const { prisma, forAccount } = fakePrisma([conv('a', 'brand-a')]);
    await ctrlFor(prisma).getPlayerFeed(
      { playerId: 'p1', brandId: 'brand-a' },
      md('acc-1'),
    );
    // Isolation is via forAccount, not a `where` the caller controls.
    expect(forAccount).toHaveBeenCalledWith('acc-1');
  });

  it('returns an empty feed for an unknown/empty player (no existence disclosure)', async () => {
    const { prisma, findMany } = fakePrisma([conv('a', 'brand-a')]);
    const res = await ctrlFor(prisma).getPlayerFeed(
      { playerId: '', brandId: 'brand-a' },
      md('acc-1'),
    );
    expect(res.conversations).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
