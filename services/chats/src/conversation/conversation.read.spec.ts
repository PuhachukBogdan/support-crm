import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import type { SlaRepository } from '../sla/sla.repository';
import { ConversationRepository } from './conversation.repository';
import { ConversationReadController } from './conversation.grpc.controller';
import { MAX_PAGE_SIZE } from '../shared/cursor';

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

describe('ConversationReadController.listConversations (US1)', () => {
  it('scopes to the caller account and builds the filter where-clause', async () => {
    const { prisma, findMany, forAccount } = fakePrisma([row()]);
    const ctrl = new ConversationReadController(new ConversationRepository(prisma), noSla());

    const res = await ctrl.listConversations(
      { status: 'CONVERSATION_STATUS_OPEN', priority: 'high', playerId: 'p1' },
      md('acc-1'),
    );

    expect(forAccount).toHaveBeenCalledWith('acc-1'); // account isolation (Principle I)
    const args = findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ status: 'open', priority: 'high', player_id: 'p1' });
    // No brand predicate: the caller asked for none. The intersection-with-permitted-brands that used
    // to be asserted here is gone with the concept (ADR 0038 §1) — account isolation still holds, and
    // it is now the only wall.
    expect(args.where.brand_id).toBeUndefined();
    expect(args.orderBy).toEqual([{ created_at: 'desc' }, { id: 'desc' }]);
    expect(res.conversations[0]).toMatchObject({ id: 'c1', status: 'CONVERSATION_STATUS_OPEN' });
  });

  it('applies no brand filter when the caller asked for none', async () => {
    const { prisma, findMany } = fakePrisma([row()]);
    const ctrl = new ConversationReadController(new ConversationRepository(prisma), noSla());
    await ctrl.listConversations({}, md('acc-1')); // no brands metadata
    expect(findMany.mock.calls[0][0].where.brand_id).toBeUndefined();
  });

  it('narrows to the brand the caller ASKED FOR — a filter, not a scope', async () => {
    // ⚠️ Was: "narrows to the requested brand only when it is PERMITTED (else empty result set)".
    // There is no such thing as an unpermitted brand (ADR 0038 §1): one support department serves
    // every brand. A filter narrows what you asked for; a scope narrows what you may ask for. Only
    // the first exists, so asking for any brand returns that brand.
    const { prisma, findMany } = fakePrisma([]);
    const ctrl = new ConversationReadController(new ConversationRepository(prisma), noSla());
    await ctrl.listConversations({ brandId: 'brand-z' }, md('acc-1'));
    expect(findMany.mock.calls[0][0].where.brand_id).toEqual({ in: ['brand-z'] });
  });

  it('caps an oversized page_size and returns a next token when more remain', async () => {
    // limit is capped to MAX_PAGE_SIZE=100 → take=101; return 101 rows → hasMore, keep 100.
    const rows = Array.from({ length: MAX_PAGE_SIZE + 1 }, (_, i) =>
      row({ id: `c${i}`, created_at: new Date(Date.now() - i * 1000) }),
    );
    const { prisma, findMany } = fakePrisma(rows);
    const ctrl = new ConversationReadController(new ConversationRepository(prisma), noSla());
    const res = await ctrl.listConversations({ pageSize: 10_000 }, md('acc-1'));
    expect(findMany.mock.calls[0][0].take).toBe(MAX_PAGE_SIZE + 1);
    expect(res.conversations).toHaveLength(MAX_PAGE_SIZE);
    expect(res.nextPageToken).not.toBe('');
  });

  it('rejects a malformed page token with INVALID_ARGUMENT (no unfiltered fallback)', async () => {
    const { prisma } = fakePrisma([]);
    const ctrl = new ConversationReadController(new ConversationRepository(prisma), noSla());
    await expect(ctrl.listConversations({ pageToken: 'garbage-$$$' }, md('acc-1'))).rejects.toBeInstanceOf(
      RpcException,
    );
  });
});
