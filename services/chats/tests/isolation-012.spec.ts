import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../src/prisma.service';
import { ConversationRepository } from '../src/conversation/conversation.repository';
import type { SlaRepository } from '../src/sla/sla.repository';
import { ConversationReadController } from '../src/conversation/conversation.grpc.controller';
import { FeedReadController } from '../src/feed/feed.grpc.controller';
import type { PersonMembersClient } from '../src/person/person-members.client';

/**
 * T033 (feature 012) — consolidated cross-account isolation sweep (Principle I / SC-003). A store
 * holds conversations in TWO accounts that share the SAME `player_id`. The scoped client only ever
 * returns the caller-account rows (this simulates the feature-007 `forAccount` extension). Every
 * read path — list, open-by-id, player-feed — is exercised as acc-1 and must never surface acc-2.
 */
const STORE = [
  mk('c1', 'acc-1', 'brand-a'),
  mk('c2', 'acc-2', 'brand-a'), // SAME player_id 'p1', DIFFERENT account — the isolation trap
];

function mk(id: string, account_id: string, brand_id: string) {
  return {
    id,
    account_id,
    brand_id,
    player_id: 'p1',
    status: 'open',
    priority: null,
    assignee_operator_id: null,
    channel: null,
    reference: null,
    category: null,
    sub_category: null,
    classified_by: null,
    created_at: new Date('2026-07-22T10:00:00.000Z'),
    updated_at: new Date('2026-07-22T10:00:00.000Z'),
  };
}

/** A fake whose forAccount(acc) confines every conversation op to `acc` — like the 007 extension. */
function fakePrisma() {
  const forAccount = jest.fn((acc: string) => ({
    conversation: {
      findMany: jest.fn((args: { where: Record<string, unknown> }) => {
        const w = args.where;
        return Promise.resolve(
          STORE.filter((r) => r.account_id === acc)
            .filter((r) => !w.player_id || r.player_id === w.player_id)
            .filter((r) => {
              const b = w.brand_id as { in?: string[] } | undefined;
              return !b?.in || b.in.includes(r.brand_id);
            }),
        );
      }),
      findFirst: jest.fn((args: { where: { id: string } }) =>
        Promise.resolve(STORE.find((r) => r.account_id === acc && r.id === args.where.id) ?? null),
      ),
    },
  }));
  return { forAccount } as unknown as PrismaService;
}

function md(accountId: string): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'op-1');
  return m;
}

/** Feature 014: the read controller gained the SLA repository; stubbed for this isolation sweep. */
function noSla() {
  return {
    conversationIdsByOutcome: jest.fn(async () => [] as string[]),
    getState: jest.fn(async () => null),
  } as unknown as SlaRepository;
}

describe('cross-account isolation sweep (SC-003)', () => {
  const repo = () => new ConversationRepository(fakePrisma());
  /**
   * Feature 022's second dependency on this controller. A THROWING stub, because the player feed holds the
   * full identity and must never resolve person membership — and in an isolation file that matters twice
   * over: a cross-service call would be a second place where an account boundary has to be re-established.
   */
  const noMembers = () =>
    ({
      membersOf: () => {
        throw new Error('the player feed must not resolve person membership');
      },
    }) as unknown as PersonMembersClient;

  it('list by player_id returns only the caller account rows', async () => {
    const res = await new ConversationReadController(repo(), noSla()).listConversations(
      { playerId: 'p1' },
      md('acc-1'),
    );
    expect(res.conversations.map((c) => c.id)).toEqual(['c1']); // never c2 (acc-2)
  });

  it('open-by-id of another account row is NOT_FOUND', async () => {
    await expect(
      new ConversationReadController(repo(), noSla()).getConversation({ id: 'c2' }, md('acc-1')),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('the SAME player_id in two accounts stays two feeds (Principle I)', async () => {
    // Feature 020 added the brand to the request; the isolation property this test exists for is
    // untouched — and it is now the LESSER of two separations, since the same id under two brands
    // inside ONE account is also two customers (see feed.spec.ts).
    const res = await new FeedReadController(repo(), noMembers()).getPlayerFeed(
      { playerId: 'p1', brandId: 'brand-a' },
      md('acc-1'),
    );
    expect(res.conversations.map((c) => c.id)).toEqual(['c1']);

    // …and from acc-2's side, only c2 — symmetric proof.
    const other = await new FeedReadController(repo(), noMembers()).getPlayerFeed(
      { playerId: 'p1', brandId: 'brand-a' },
      md('acc-2'),
    );
    expect(other.conversations.map((c) => c.id)).toEqual(['c2']);
  });
});
