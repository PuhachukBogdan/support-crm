import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { MessageRepository } from './message.repository';
import type { DomainEventPublisher } from '../events/events.publisher';
import type { FirstReplyClock } from '../sla/first-reply.clock';
import { MessageWriteController } from './message.grpc.controller';
import type { UploadsClient } from '../uploads/uploads.client';
import { fakeRealtime } from '../realtime/realtime.fake';
import { TransitionRecorder } from '../transition/transition.recorder';

/**
 * Feature 033: the delivery-intent writer, stubbed to do NOTHING.
 *
 * These specs post on tickets whose channel is not email, so the real repository would enqueue nothing
 * either — the stub keeps that true without giving the fake transaction a `channel` delegate. The
 * enqueue rule itself is asserted in `services/chats/src/channel/outbound.spec.ts`, where a public reply
 * on an email ticket must produce exactly one intent and a private note none.
 */
function noOutbox() {
  return {
    enqueue: async () => undefined,
  } as unknown as import('../channel/outbound.repository').OutboundRepository;
}


function md(accountId = 'acc-1', userId = 'op-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', userId);
  return m;
}

/** The timestamp the fake's database assigns to a created message. */
const CREATED_AT = new Date('2026-07-22T12:00:00.000Z');

/**
 * Fake scoped Prisma: conversation brand lookup, message create echoing the input, and — since feature
 * 022 — the contact-stamp update plus the interactive `$transaction` the write now runs in.
 *
 * `updateMany` calls are collected so the stamp can be asserted on: WHICH column, and with what value.
 */
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
      created_at: CREATED_AT,
    }),
  );
  // Feature 023: the same `findFirst` answers the brand check AND the write path's before-row read.
  // The title is returned as ALREADY FROZEN (`subject_source: 'auto'`) so these specs stay about the
  // contact stamp: the window has its own file, `message.subject-window.spec.ts`, whose fake behaves
  // like a database. A fake that left the window open here would make every stamp assertion also an
  // assertion about titles, which is how a spec stops saying what its name says.
  const findFirst = jest
    .fn()
    .mockResolvedValue(brand === null ? null : { brand_id: brand, subject_source: 'auto' });
  const stamps: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const updateMany = jest.fn(
    (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      stamps.push(args);
      return Promise.resolve({ count: 1 });
    },
  );
  const createMany = jest.fn(() => Promise.resolve({ count: 0 }));
  const scoped = {
    message: {
      create,
      // A NAMED stub that throws, not a permissive mock: the title window is frozen above, so nothing
      // here may count messages. If a future edit makes the frozen path count anyway, these specs fail
      // loudly instead of passing against a fake that answered.
      count: () => {
        throw new Error('a frozen title window must not count messages');
      },
    },
    conversation: { findFirst, updateMany },
    // Feature 023 (T019): the first public reply is recorded as a transition inside this same
    // transaction, so the fake needs the table and a before-row read.
    conversationTransition: { create: jest.fn().mockResolvedValue({}) },
    messageAttachment: { createMany },
  } as Record<string, unknown>;
  // The INTERACTIVE form: `post` needs the created row's own `created_at` (research R2), which the
  // batch form cannot reference. Handing the same scoped object to the callback is faithful — at
  // runtime the account-scoping extension wraps every operation inside the transaction too.
  (scoped as { $transaction: unknown }).$transaction = (fn: (tx: unknown) => Promise<unknown>) =>
    fn(scoped);
  const forAccount = jest.fn().mockReturnValue(scoped);
  return { prisma: { forAccount } as unknown as PrismaService, create, findFirst, stamps };
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

/**
 * Feature 016 gave the write controller an uploads client. These 012 specs post messages with NO
 * attachments, so the client is never consulted — but the constructor needs one.
 *
 * A NAMED stub whose methods throw, rather than a loosened constructor or a silently permissive
 * mock: if a future edit makes the no-attachment path call users, these specs fail loudly instead of
 * passing against a fake that answered anyway. Same reasoning features 014/015 used for their own
 * stubs.
 */
function noUploads() {
  const unexpected = () => {
    throw new Error('a message with no attachments must not consult the uploads service');
  };
  return { describe: unexpected, claim: unexpected } as unknown as UploadsClient;
}

describe('MessageWriteController.postMessage (US2)', () => {
  it('posts a public reply authored by the acting operator', async () => {
    const { prisma, create } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noEvents(), noClock(), noUploads(), fakeRealtime().publisher);
    const res = await ctrl.postMessage(
      { conversationId: 'c1', kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'hi' },
      md('acc-1', 'op-1'),
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
    const ctrl = new MessageWriteController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noEvents(), noClock(), noUploads(), fakeRealtime().publisher);
    const res = await ctrl.postMessage(
      { conversationId: 'c1', kind: 'MESSAGE_KIND_PRIVATE_NOTE', body: 'psst', mentions: ['op-2'] },
      md('acc-1', 'op-1'),
    );
    expect(create.mock.calls[0]![0].data).toMatchObject({ private: true, mentions: ['op-2'] });
    expect(res.kind).toBe('MESSAGE_KIND_PRIVATE_NOTE');
  });

  it('drops mentions on a public reply (mentions belong to private notes)', async () => {
    const { prisma, create } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noEvents(), noClock(), noUploads(), fakeRealtime().publisher);
    await ctrl.postMessage(
      { conversationId: 'c1', kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'hi', mentions: ['op-2'] },
      md('acc-1', 'op-1'),
    );
    expect(create.mock.calls[0]![0].data.mentions).toEqual([]);
  });

  it('rejects a non-postable kind (incoming/system/unspecified)', async () => {
    const { prisma } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noEvents(), noClock(), noUploads(), fakeRealtime().publisher);
    await expect(
      ctrl.postMessage({ conversationId: 'c1', kind: 'MESSAGE_KIND_INCOMING_CUSTOMER', body: 'x' }, md()),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('is NOT_FOUND when the conversation is absent / brand not permitted', async () => {
    const { prisma } = fakePrisma(null); // conversation not found in account
    const ctrl = new MessageWriteController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noEvents(), noClock(), noUploads(), fakeRealtime().publisher);
    await expect(
      ctrl.postMessage({ conversationId: 'nope', kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'x' }, md('acc-1', 'op-1')),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('RecordIncomingMessage yields an INCOMING_CUSTOMER message (FR-009)', async () => {
    const { prisma, create } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noEvents(), noClock(), noUploads(), fakeRealtime().publisher);
    const res = await ctrl.recordIncomingMessage(
      { conversationId: 'c1', body: 'help', authorId: 'player-9' },
      md('acc-1', 'op-1'),
    );
    expect(create.mock.calls[0]![0].data).toMatchObject({ author_type: 'player', private: false });
    expect(res.kind).toBe('MESSAGE_KIND_INCOMING_CUSTOMER');
  });
});

/**
 * Feature 022 (roadmap 4.13), T014 — **the write records its effect on the conversation.**
 *
 * The player card's "last contact" is these two columns. What makes them trustworthy is that they are
 * written in the message's OWN transaction, from the message's OWN timestamp, for the column
 * `contact-stamp.ts` selects — and for NO column when the message is not contact with the customer.
 *
 * The two cases that look like contact and are not (a private note, a system entry) are asserted here
 * as well as in `contact-stamp.spec.ts`: that file proves the rule, this one proves the call site obeys
 * it. Feature 014's live-only lesson was that a rule can be right while the place that consults it is
 * not.
 */
describe('the contact stamp is written with the message (feature 022)', () => {
  it('a PUBLIC reply stamps last_outbound_at with the created message’s own timestamp', async () => {
    const { prisma, stamps } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noEvents(), noClock(), noUploads(), fakeRealtime().publisher);
    await ctrl.postMessage(
      { conversationId: 'c1', kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'answered' },
      md('acc-1', 'op-1'),
    );
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.where).toEqual({ id: 'c1' });
    // The row's own `created_at`, not `new Date()` in the service: that is what makes "the column equals
    // what the messages say" an equality rather than a tolerance (research R2).
    expect(stamps[0]!.data).toEqual({ last_outbound_at: CREATED_AT });
  });

  it('an INBOUND customer message stamps last_inbound_at', async () => {
    const { prisma, stamps } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noEvents(), noClock(), noUploads(), fakeRealtime().publisher);
    await ctrl.recordIncomingMessage(
      { conversationId: 'c1', body: 'help', authorId: 'player-9' },
      md('acc-1', 'op-1'),
    );
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.data).toEqual({ last_inbound_at: CREATED_AT });
  });

  it('a PRIVATE NOTE stamps NOTHING — no update statement is issued at all', async () => {
    const { prisma, stamps } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noEvents(), noClock(), noUploads(), fakeRealtime().publisher);
    const res = await ctrl.postMessage(
      { conversationId: 'c1', kind: 'MESSAGE_KIND_PRIVATE_NOTE', body: 'internal', mentions: ['op-2'] },
      md('acc-1', 'op-1'),
    );
    // The note itself is still written — it is inert for CONTACT, not skipped.
    expect(res.kind).toBe('MESSAGE_KIND_PRIVATE_NOTE');
    expect(stamps).toEqual([]);
  });

  it('the stamp writes exactly ONE column, never both', async () => {
    // A "helpful" future edit that also touched the other column would make a reply look like the
    // customer wrote, which is the single most misleading thing this card can say.
    const { prisma, stamps } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noEvents(), noClock(), noUploads(), fakeRealtime().publisher);
    await ctrl.postMessage(
      { conversationId: 'c1', kind: 'MESSAGE_KIND_PUBLIC_REPLY', body: 'x' },
      md('acc-1', 'op-1'),
    );
    expect(Object.keys(stamps[0]!.data)).toEqual(['last_outbound_at']);
  });

  it('never touches updated_at — the column this feature exists to stop trusting', async () => {
    const { prisma, stamps } = fakePrisma();
    const ctrl = new MessageWriteController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noEvents(), noClock(), noUploads(), fakeRealtime().publisher);
    await ctrl.recordIncomingMessage({ conversationId: 'c1', body: 'hi' }, md('acc-1', 'op-1'));
    for (const s of stamps) {
      expect(Object.keys(s.data)).not.toContain('updated_at');
      expect(Object.keys(s.data)).not.toContain('created_at');
    }
  });
});
