import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { MessageRepository } from './message.repository';
import type { DomainEventPublisher } from '../events/events.publisher';
import type { FirstReplyClock } from '../sla/first-reply.clock';
import { MessageWriteController } from './message.grpc.controller';

function md(accountId = 'acc-1', userId = 'op-1', brands?: string[]): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', userId);
  if (brands) m.set('x-actor-brands', brands.join(','));
  return m;
}

/** Fake scoped Prisma: conversation brand lookup + message create echoing the input. */
function fakePrisma(brand: string | null = 'brand-a') {
  const create = jest.fn((args: { data: Record<string, unknown> }) =>
    Promise.resolve({
      id: 'm-new',
      conversation_id: args.data.conversation_id,
      author_type: args.data.author_type,
      author_id: args.data.author_id,
      body: args.data.body,
      private: args.data.private,
      mentions: args.data.mentions ?? [],
      created_at: new Date('2026-07-22T12:00:00.000Z'),
    }),
  );
  const findFirst = jest.fn().mockResolvedValue(brand === null ? null : { brand_id: brand });
  const forAccount = jest
    .fn()
    .mockReturnValue({ message: { create }, conversation: { findFirst } });
  return { prisma: { forAccount } as unknown as PrismaService, create, findFirst };
}

/**
 * Feature 014 added an event publisher to the write controller (an inbound player message is what
 * starts the first-reply clock and what rules react to). These 012 specs are about the message write
 * itself, so it is stubbed — publishing has its own specs.
 */
function noEvents() {
  return { messageReceived: jest.fn(async () => 0) } as unknown as DomainEventPublisher;
}

/**
 * Feature 014 also hung the first-reply clock off these edges. Its behaviour (a private note does not
 * stop the clock, etc.) has its own specs — sla/first-reply.spec.ts and sla/clock.spec.ts — so here it
 * is a no-op.
 */
function noClock() {
  return {
    onInboundPlayerMessage: jest.fn(async () => undefined),
    onStaffMessage: jest.fn(async () => undefined),
  } as unknown as FirstReplyClock;
}

describe('MessageWriteController.postMessage (US2)', () => {
  it('posts a public reply authored by the acting operator', async () => {
    const { prisma, create } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma), noEvents(), noClock());
    const res = await ctrl.postMessage(
      { conversationId: 'c1', kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'hi' },
      md('acc-1', 'op-1', ['brand-a']),
    );
    expect(create.mock.calls[0]![0].data).toMatchObject({
      author_type: 'operator',
      author_id: 'op-1',
      private: false,
      mentions: [],
    });
    expect(res.kind).toBe('MESSAGE_KIND_PUBLIC_REPLY');
  });

  it('posts a private note and captures @mentions (R6)', async () => {
    const { prisma, create } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma), noEvents(), noClock());
    const res = await ctrl.postMessage(
      { conversationId: 'c1', kind: 'MESSAGE_KIND_PRIVATE_NOTE', body: 'psst', mentions: ['op-2'] },
      md('acc-1', 'op-1', ['brand-a']),
    );
    expect(create.mock.calls[0]![0].data).toMatchObject({ private: true, mentions: ['op-2'] });
    expect(res.kind).toBe('MESSAGE_KIND_PRIVATE_NOTE');
  });

  it('drops mentions on a public reply (mentions belong to private notes)', async () => {
    const { prisma, create } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma), noEvents(), noClock());
    await ctrl.postMessage(
      { conversationId: 'c1', kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'hi', mentions: ['op-2'] },
      md('acc-1', 'op-1', ['brand-a']),
    );
    expect(create.mock.calls[0]![0].data.mentions).toEqual([]);
  });

  it('rejects a non-postable kind (incoming/system/unspecified)', async () => {
    const { prisma } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma), noEvents(), noClock());
    await expect(
      ctrl.postMessage({ conversationId: 'c1', kind: 'MESSAGE_KIND_INCOMING_CUSTOMER', body: 'x' }, md()),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('is NOT_FOUND when the conversation is absent / brand not permitted', async () => {
    const { prisma } = fakePrisma(null); // conversation not found in account
    const ctrl = new MessageWriteController(new MessageRepository(prisma), noEvents(), noClock());
    await expect(
      ctrl.postMessage({ conversationId: 'nope', kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'x' }, md('acc-1', 'op-1', ['brand-a'])),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('RecordIncomingMessage yields an INCOMING_CUSTOMER message (FR-009)', async () => {
    const { prisma, create } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma), noEvents(), noClock());
    const res = await ctrl.recordIncomingMessage(
      { conversationId: 'c1', body: 'help', authorId: 'player-9' },
      md('acc-1', 'op-1', ['brand-a']),
    );
    expect(create.mock.calls[0]![0].data).toMatchObject({ author_type: 'player', private: false });
    expect(res.kind).toBe('MESSAGE_KIND_INCOMING_CUSTOMER');
  });
});
