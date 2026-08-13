import { Metadata } from '@grpc/grpc-js';
import type { PrismaService } from '../prisma.service';
import { MessageRepository } from './message.repository';
import { MessageReadController } from './message.grpc.controller';
import type { UploadsClient } from '../uploads/uploads.client';
import { TransitionRecorder } from '../transition/transition.recorder';

/**
 * Feature 033: the delivery-intent writer, stubbed to do NOTHING.
 *
 * These specs post on tickets whose channel is not email, so the real repository would enqueue nothing
 * either — the stub keeps that true without giving the fake transaction a `channel` delegate. The enqueue
 * rule itself is asserted in `services/chats/src/channel/outbound.spec.ts`, where a public reply on an
 * email ticket must produce exactly one intent and a private note none.
 */
function noOutbox() {
  return {
    enqueue: async () => undefined,
  } as unknown as import('../channel/outbound.repository').OutboundRepository;
}


function md(accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'op-1');
  return m;
}

const ALL_MESSAGES = [
  {
    id: 'm1',
    conversation_id: 'c1',
    author_type: 'player',
    author_id: 'p1',
    body: 'customer question',
    private: false,
    mentions: [],
    created_at: new Date('2026-07-22T10:00:00.000Z'),
  },
  {
    id: 'm2',
    conversation_id: 'c1',
    author_type: 'operator',
    author_id: 'op-1',
    body: 'public reply',
    private: false,
    mentions: [],
    created_at: new Date('2026-07-22T10:01:00.000Z'),
  },
  {
    id: 'm3',
    conversation_id: 'c1',
    author_type: 'operator',
    author_id: 'op-1',
    body: 'SECRET internal note — segment check',
    private: true,
    mentions: ['op-2'],
    created_at: new Date('2026-07-22T10:02:00.000Z'),
  },
];

/** Fake that actually APPLIES the query's where — so an excluded row is truly absent, not hidden. */
function fakePrisma() {
  const findMany = jest.fn((args: { where: Record<string, unknown>; orderBy?: unknown }) => {
    const w = args.where;
    let rows = ALL_MESSAGES.filter((r) => r.conversation_id === w.conversation_id);
    if (w.private === false) rows = rows.filter((r) => r.private === false);
    const at = w.author_type as { not?: string } | undefined;
    if (at?.not) rows = rows.filter((r) => r.author_type !== at.not);
    return Promise.resolve(rows);
  });
  const findFirst = jest.fn().mockResolvedValue({ brand_id: 'brand-a' });
  const forAccount = jest
    .fn()
    .mockReturnValue({ message: { findMany }, conversation: { findFirst } });
  return { prisma: { forAccount } as unknown as PrismaService, findMany };
}

/**
 * Feature 016 gave the read controller an uploads client (attachment metadata is fetched once per
 * thread page). These 012 messages carry no attachments, so it must never be consulted — a NAMED
 * stub that throws says so, where a permissive mock would hide a future N+1 or an unnecessary hop.
 */
function noUploads() {
  return {
    describe: () => {
      throw new Error('a page with no attachments must not consult the uploads service');
    },
    claim: () => {
      throw new Error('a read must never claim');
    },
  } as unknown as UploadsClient;
}

describe('GetThread projection — SEC-13 / SC-002 (zero tolerance)', () => {
  it('STAFF projection includes the private note', async () => {
    const { prisma } = fakePrisma();
    const ctrl = new MessageReadController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noUploads());
    const res = await ctrl.getThread(
      { conversationId: 'c1', projection: 'THREAD_PROJECTION_STAFF' },
      md(),
    );
    const kinds = res.messages.map((m) => m.kind);
    expect(kinds).toContain('MESSAGE_KIND_PRIVATE_NOTE');
    expect(res.messages.some((m) => m.body.includes('SECRET'))).toBe(true);
  });

  it('CUSTOMER projection is STRUCTURALLY ABSENT the private note (query-level, not a flag)', async () => {
    const { prisma, findMany } = fakePrisma();
    const ctrl = new MessageReadController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noUploads());
    const res = await ctrl.getThread(
      { conversationId: 'c1', projection: 'THREAD_PROJECTION_CUSTOMER' },
      md(),
    );
    // The query itself excludes private rows (R4) …
    expect(findMany.mock.calls[0]![0].where.private).toBe(false);
    // … and nothing in the returned payload carries the note (no body, no metadata, no kind).
    expect(res.messages.some((m) => m.kind === 'MESSAGE_KIND_PRIVATE_NOTE')).toBe(false);
    expect(JSON.stringify(res)).not.toContain('SECRET');
    expect(JSON.stringify(res)).not.toContain('op-2'); // mention metadata gone too
    expect(res.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('reads the thread in chronological order (FR-009)', async () => {
    const { prisma, findMany } = fakePrisma();
    const ctrl = new MessageReadController(new MessageRepository(prisma, new TransitionRecorder(), noOutbox()), noUploads());
    await ctrl.getThread({ conversationId: 'c1', projection: 'THREAD_PROJECTION_STAFF' }, md());
    expect(findMany.mock.calls[0]![0].orderBy).toEqual([{ created_at: 'asc' }, { id: 'asc' }]);
  });
});
