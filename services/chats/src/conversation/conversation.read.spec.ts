import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import type { SlaRepository } from '../sla/sla.repository';
import { ConversationRepository } from './conversation.repository';
import { ConversationReadController } from './conversation.grpc.controller';
import { MAX_PAGE_SIZE } from '../shared/cursor';
import { TransitionRecorder } from '../transition/transition.recorder';
import { PersonMembersClient } from '../person/person-members.client';
import { fakeStatusRepository } from '../status/status.fixture';
import { noOperatorIdentity, noReadMarks } from '../shared/operator-identity.fake';

/** A fake account-scoped Prisma exposing only the conversation delegate used here (Track A). */
function fakePrisma(rows: unknown[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const forAccount = jest.fn().mockReturnValue({ conversation: { findMany } });
  return { prisma: { forAccount } as unknown as PrismaService, findMany, forAccount };
}

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'c1',
    brand_id: 'brand-a',
    player_id: 'p1',
    status: 'open',
    priority: 'high',
    assignee_operator_id: 'op1',
    channel: 'web',
    created_at: new Date('2026-07-22T10:00:00.000Z'),
    updated_at: new Date('2026-07-22T11:00:00.000Z'),
    ...over,
  };
}

function md(accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
  return m;
}

/**
 * Feature 014 added the SLA repository to the read controller (the `slaOutcome` inbox filter and the
 * first-reply state on the detail). These specs predate it and are about account/brand scope + paging,
 * so it is stubbed: no filter requested ⇒ never consulted; no clock ⇒ no state on the detail.
 */
function noSla() {
  return {
    conversationIdsByOutcome: jest.fn(async () => [] as string[]),
    getState: jest.fn(async () => null),
  } as unknown as SlaRepository;
}

/**
 * Feature 030: a portfolio client that **throws if it is ever consulted**.
 *
 * ⚠️ Deliberately not a client returning `[]`. Every caller in this file is a role that is NOT
 * portfolio-scoped, so the client must never be reached — and an empty portfolio would look identical to
 * "not scoped" while silently matching nothing. If a test here ever starts narrowing, it fails loudly
 * instead of passing with an empty queue.
 */
function noPortfolio() {
  return {
    attachedPlayersOfCaller: jest.fn(async () => {
      throw new Error('portfolio must not be consulted for a non-AM caller');
    }),
  } as unknown as PersonMembersClient;
}

describe('ConversationReadController.listConversations (US1)', () => {
  it('scopes to the caller account and builds the filter where-clause', async () => {
    const { prisma, findMany, forAccount } = fakePrisma([row()]);
    const ctrl = new ConversationReadController(
      new ConversationRepository(prisma, new TransitionRecorder()),
      noSla(),
      noPortfolio(),
      fakeStatusRepository(),
      noOperatorIdentity(),
      noReadMarks(),
    );

    const res = await ctrl.listConversations(
      // Feature 032: the filter names a status KEY; the retired enum field is refused, not mapped.
      { statusKey: 'open', priority: 'high', playerId: 'p1' },
      md('acc-1'),
    );

    expect(forAccount).toHaveBeenCalledWith('acc-1'); // account isolation (Principle I)
    const args = findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ status: { in: ['open'] }, priority: 'high', player_id: 'p1' });
    // No brand predicate: the caller asked for none. The intersection-with-permitted-brands that used
    // to be asserted here is gone with the concept (ADR 0038 §1) — account isolation still holds, and
    // it is now the only wall.
    expect(args.where.brand_id).toBeUndefined();
    // ⚠️ CHANGED by feature 029 (research R1/R7). This used to assert `created_at desc`, which was the
    // only order the list had ever had. Creation order buries a conversation touched five minutes ago
    // under one opened yesterday, so the Inbox's default is now the update time. The assertion is
    // rewritten rather than removed: it still pins the default, it just pins the new one.
    expect(args.orderBy).toEqual([{ updated_at: 'desc' }, { id: 'desc' }]);
    expect(res.conversations[0]).toMatchObject({ id: 'c1', statusKey: 'open' });
  });

  it('applies no brand filter when the caller asked for none', async () => {
    const { prisma, findMany } = fakePrisma([row()]);
    const ctrl = new ConversationReadController(
      new ConversationRepository(prisma, new TransitionRecorder()),
      noSla(),
      noPortfolio(),
      fakeStatusRepository(),
      noOperatorIdentity(),
      noReadMarks(),
    );
    await ctrl.listConversations({}, md('acc-1')); // no brands metadata
    expect(findMany.mock.calls[0][0].where.brand_id).toBeUndefined();
  });

  it('narrows to the brand the caller ASKED FOR — a filter, not a scope', async () => {
    // ⚠️ Was: "narrows to the requested brand only when it is PERMITTED (else empty result set)".
    // There is no such thing as an unpermitted brand (ADR 0038 §1): one support department serves
    // every brand. A filter narrows what you asked for; a scope narrows what you may ask for. Only
    // the first exists, so asking for any brand returns that brand.
    const { prisma, findMany } = fakePrisma([]);
    const ctrl = new ConversationReadController(
      new ConversationRepository(prisma, new TransitionRecorder()),
      noSla(),
      noPortfolio(),
      fakeStatusRepository(),
      noOperatorIdentity(),
      noReadMarks(),
    );
    await ctrl.listConversations({ brandId: 'brand-z' }, md('acc-1'));
    expect(findMany.mock.calls[0][0].where.brand_id).toEqual({ in: ['brand-z'] });
  });

  it('caps an oversized page_size and returns a next token when more remain', async () => {
    // limit is capped to MAX_PAGE_SIZE=100 → take=101; return 101 rows → hasMore, keep 100.
    const rows = Array.from({ length: MAX_PAGE_SIZE + 1 }, (_, i) =>
      row({ id: `c${i}`, created_at: new Date(Date.now() - i * 1000) }),
    );
    const { prisma, findMany } = fakePrisma(rows);
    const ctrl = new ConversationReadController(
      new ConversationRepository(prisma, new TransitionRecorder()),
      noSla(),
      noPortfolio(),
      fakeStatusRepository(),
      noOperatorIdentity(),
      noReadMarks(),
    );
    const res = await ctrl.listConversations({ pageSize: 10_000 }, md('acc-1'));
    expect(findMany.mock.calls[0][0].take).toBe(MAX_PAGE_SIZE + 1);
    expect(res.conversations).toHaveLength(MAX_PAGE_SIZE);
    expect(res.nextPageToken).not.toBe('');
  });

  it('rejects a malformed page token with INVALID_ARGUMENT (no unfiltered fallback)', async () => {
    const { prisma } = fakePrisma([]);
    const ctrl = new ConversationReadController(
      new ConversationRepository(prisma, new TransitionRecorder()),
      noSla(),
      noPortfolio(),
      fakeStatusRepository(),
      noOperatorIdentity(),
      noReadMarks(),
    );
    await expect(ctrl.listConversations({ pageToken: 'garbage-$$$' }, md('acc-1'))).rejects.toBeInstanceOf(
      RpcException,
    );
  });
});

/**
 * T007 (feature 029, roadmap 9.2) — the two widenings the Inbox needs: a `channel` filter and a
 * choice of order.
 *
 * ⚠️ These assert on the ARGUMENTS handed to Prisma, which is the most a fake can prove. That a
 * filter actually narrows real rows, and that the second page of a re-ordered list is the right one,
 * are Track B's job (quickstart B2/B3) — a fake returns whatever it was handed, so a dropped
 * parameter and an honoured one look identical here. This is the recorded failure shape.
 */
describe('*** the channel filter (feature 029, FR-011) ***', () => {
  function ctrlWith(rows: unknown[]) {
    const f = fakePrisma(rows);
    return {
      ...f,
      ctrl: new ConversationReadController(
        new ConversationRepository(f.prisma, new TransitionRecorder()),
        noSla(),
        noPortfolio(),
        fakeStatusRepository(),
        noOperatorIdentity(),
        noReadMarks(),
      ),
    };
  }

  it('narrows on channel when one is asked for', async () => {
    const { ctrl, findMany } = ctrlWith([row({ channel: 'email' })]);
    await ctrl.listConversations({ channel: 'email' }, md('acc-1'));
    expect(findMany.mock.calls[0][0].where).toMatchObject({ channel: 'email' });
  });

  it('⚠️ applies NO channel predicate when none is asked for — empty-channel rows stay reachable', async () => {
    // ~1 in 6 conversations on the stand have no channel at all. If "no filter" ever became
    // `channel: null` or `channel: ''`, a fifth of the queue would vanish from the default view — and
    // the list would still look perfectly healthy.
    const { ctrl, findMany } = ctrlWith([row({ channel: null })]);
    await ctrl.listConversations({}, md('acc-1'));
    expect(findMany.mock.calls[0][0].where.channel).toBeUndefined();
  });

  it('treats an empty-string channel as NO filter, not as "has no channel"', async () => {
    const { ctrl, findMany } = ctrlWith([row()]);
    await ctrl.listConversations({ channel: '' }, md('acc-1'));
    expect(findMany.mock.calls[0][0].where.channel).toBeUndefined();
  });
});

describe('*** the two orders, and the cursor that belongs to them (feature 029, FR-012/R8) ***', () => {
  function ctrlWith(rows: unknown[]) {
    const f = fakePrisma(rows);
    return {
      ...f,
      ctrl: new ConversationReadController(
        new ConversationRepository(f.prisma, new TransitionRecorder()),
        noSla(),
        noPortfolio(),
        fakeStatusRepository(),
        noOperatorIdentity(),
        noReadMarks(),
      ),
    };
  }

  it('defaults to newest-updated first when no order is named', async () => {
    const { ctrl, findMany } = ctrlWith([row()]);
    await ctrl.listConversations({}, md('acc-1'));
    expect(findMany.mock.calls[0][0].orderBy).toEqual([{ updated_at: 'desc' }, { id: 'desc' }]);
  });

  it('orders oldest-updated first when asked', async () => {
    const { ctrl, findMany } = ctrlWith([row()]);
    await ctrl.listConversations({ order: 'CONVERSATION_ORDER_UPDATED_ASC' }, md('acc-1'));
    expect(findMany.mock.calls[0][0].orderBy).toEqual([{ updated_at: 'asc' }, { id: 'asc' }]);
  });

  it('⭐ REFUSES an unknown order — never a silent fall-back to the default', async () => {
    // A sort that quietly does something else is the defect this contract exists to prevent: the
    // caller believes the list is in one order and it is in another, with nothing on screen to show it.
    const { ctrl } = ctrlWith([]);
    await expect(
      ctrl.listConversations({ order: 'CONVERSATION_ORDER_RECOMMENDED' }, md('acc-1')),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('⭐ the keyset PREDICATE follows the order — under asc it compares the other way', async () => {
    // The predicate and the orderBy must name the same column in the same direction. If they disagree,
    // page two is drawn from a different sequence and the result is a plausible list with rows missing.
    const rows = Array.from({ length: MAX_PAGE_SIZE + 1 }, (_, i) =>
      row({ id: `c${i}`, updated_at: new Date(Date.UTC(2026, 7, 2, 0, 0, i)) }),
    );
    const { ctrl, findMany } = ctrlWith(rows);
    const first = await ctrl.listConversations(
      { order: 'CONVERSATION_ORDER_UPDATED_ASC', pageSize: MAX_PAGE_SIZE },
      md('acc-1'),
    );
    expect(first.nextPageToken).not.toBe('');

    await ctrl.listConversations(
      {
        order: 'CONVERSATION_ORDER_UPDATED_ASC',
        pageSize: MAX_PAGE_SIZE,
        pageToken: first.nextPageToken,
      },
      md('acc-1'),
    );
    const where = findMany.mock.calls[1][0].where;
    expect(JSON.stringify(where)).toContain('gt'); // ascending ⇒ "after", not "before"
    expect(JSON.stringify(where)).toContain('updated_at');
  });

  it('⭐ REFUSES a page token minted under the OTHER order (R8)', async () => {
    const rows = Array.from({ length: MAX_PAGE_SIZE + 1 }, (_, i) => row({ id: `c${i}` }));
    const { ctrl } = ctrlWith(rows);
    const desc = await ctrl.listConversations(
      { order: 'CONVERSATION_ORDER_UPDATED_DESC', pageSize: MAX_PAGE_SIZE },
      md('acc-1'),
    );
    expect(desc.nextPageToken).not.toBe('');

    await expect(
      ctrl.listConversations(
        { order: 'CONVERSATION_ORDER_UPDATED_ASC', pageToken: desc.nextPageToken },
        md('acc-1'),
      ),
    ).rejects.toBeInstanceOf(RpcException);
  });
});
