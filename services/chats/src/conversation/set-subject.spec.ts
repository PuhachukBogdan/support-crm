import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import type { DomainEventPublisher } from '../events/events.publisher';
import { ConversationRepository } from './conversation.repository';
import { ConversationWriteController } from './conversation.write.controller';
import { TransitionRecorder } from '../transition/transition.recorder';
import { MAX_SUBJECT_LENGTH } from '../subject/subject.derive';
import { fakeStatusRepository } from '../status/status.fixture';
import { fakeRealtime } from '../realtime/realtime.fake';

/**
 * T037 / T038 / T039 (feature 023, roadmap 4.18 — FR-022 / FR-025).
 *
 * The human path end to end: the write, the lock, the transition — and what the transition does NOT
 * carry. A `manual` set must be distinguishable from an automatic one in the stream, which is how
 * "who set it and when" is answered without duplicating actor columns on the hot row (data-model §4).
 */

function md(accountId = 'acc-1', userId = 'op-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', userId);
  m.set('x-actor-effective-role', 'agent');
  return m;
}

const DETAIL = {
  id: 'c-1',
  brand_id: 'brand-a',
  player_id: 'p-1',
  status: 'open',
  priority: null,
  assignee_operator_id: null,
  channel: 'chat',
  created_at: new Date('2026-08-04T10:00:00.000Z'),
  updated_at: new Date('2026-08-04T10:00:00.000Z'),
  reference: null,
  category: null,
  sub_category: null,
  classified_by: null,
  subject: null,
  subject_source: null,
};

function fakePrisma(exists = true) {
  const row = { ...DETAIL };
  const transitions: Array<Record<string, unknown>> = [];
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];

  const scoped = {
    conversation: {
      findFirst: jest.fn(() => Promise.resolve(exists ? { ...row } : null)),
      updateMany: jest.fn((args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!exists) return Promise.resolve({ count: 0 });
        updates.push(args);
        Object.assign(row, args.data);
        return Promise.resolve({ count: 1 });
      }),
    },
    conversationTransition: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        transitions.push(args.data);
        return Promise.resolve({});
      }),
    },
  } as Record<string, unknown>;
  (scoped as { $transaction: unknown }).$transaction = (fn: (tx: unknown) => Promise<unknown>) =>
    fn(scoped);

  const prisma = { forAccount: jest.fn().mockReturnValue(scoped) } as unknown as PrismaService;
  return { prisma, row, transitions, updates };
}

/** The controller publishes automation events; a title must not be one, so this stub refuses. */
function noEvents() {
  const unexpected = () => {
    throw new Error('naming a conversation must not publish an automation event');
  };
  return {
    conversationCreated: unexpected,
    statusChanged: unexpected,
  } as unknown as DomainEventPublisher;
}

const controller = (prisma: PrismaService) =>
  new ConversationWriteController(
    new ConversationRepository(prisma, new TransitionRecorder()),
    noEvents(),
    fakeStatusRepository(),
    // The subject write touches no audit trail (see the handler's own note on why not).
    {} as never,
    fakeRealtime().publisher,
  );

const TITLE = 'выплата задерживается уже вторые сутки';

describe('T037 — SetConversationSubject: the write and the lock', () => {
  it('sets the title and marks it manual IN THE SAME statement', async () => {
    const { prisma, row, updates } = fakePrisma();
    const res = await controller(prisma).setConversationSubject(
      { conversationId: 'c-1', subject: TITLE },
      md(),
    );

    // One statement: there is no instant at which a human's wording sits in the column without the
    // mark that protects it from every automated writer.
    const write = updates.find((u) => 'subject' in u.data)!;
    expect(write.data).toEqual({ subject: TITLE, subject_source: 'manual' });
    expect(row.subject_source).toBe('manual');
    expect(res.subject).toBe(TITLE);
    expect(res.subjectSource).toBe('manual');
  });

  it('the lock is against AUTOMATION, not against people — a person may rename what a person named', async () => {
    const { prisma, updates } = fakePrisma();
    await controller(prisma).setConversationSubject({ conversationId: 'c-1', subject: TITLE }, md());
    const write = updates.find((u) => 'subject' in u.data)!;
    expect(write.where).not.toHaveProperty('subject_source');
  });

  it('collapses whitespace rather than rejecting it — a pasted line break is not an invalid intent', async () => {
    const { prisma, row } = fakePrisma();
    await controller(prisma).setConversationSubject(
      { conversationId: 'c-1', subject: '  выплата\n  задерживается  ' },
      md(),
    );
    expect(row.subject).toBe('выплата задерживается');
  });

  it('REFUSES an over-length title rather than truncating it', async () => {
    const { prisma, updates } = fakePrisma();
    await expect(
      controller(prisma).setConversationSubject(
        { conversationId: 'c-1', subject: 'я'.repeat(MAX_SUBJECT_LENGTH + 1) },
        md(),
      ),
    ).rejects.toMatchObject({ error: { code: GrpcStatus.INVALID_ARGUMENT } });
    // Nothing was written: a silently shortened title is a title the author did not write.
    expect(updates).toEqual([]);
  });

  it('the refusal names the LENGTH and never the value', async () => {
    const { prisma } = fakePrisma();
    const err = await controller(prisma)
      .setConversationSubject(
        { conversationId: 'c-1', subject: 'секретное имя клиента '.repeat(20) },
        md(),
      )
      .catch((e: RpcException) => e);
    expect(JSON.stringify(err)).not.toContain('секретное');
  });

  it('REFUSES an empty title — clearing would freeze the conversation at nothing', async () => {
    const { prisma } = fakePrisma();
    for (const subject of ['', '   ', undefined]) {
      await expect(
        controller(prisma).setConversationSubject({ conversationId: 'c-1', subject }, md()),
      ).rejects.toMatchObject({ error: { code: GrpcStatus.INVALID_ARGUMENT } });
    }
  });

  it('a conversation outside the account is NOT FOUND, with no existence disclosure', async () => {
    const { prisma } = fakePrisma(false);
    await expect(
      controller(prisma).setConversationSubject({ conversationId: 'other', subject: TITLE }, md()),
    ).rejects.toMatchObject({ error: { code: GrpcStatus.NOT_FOUND } });
  });
});

describe('T038 / T039 — the transition, and what it does not carry', () => {
  it('records `conversation.subject_set` with source MANUAL, in the same transaction', async () => {
    const { prisma, transitions } = fakePrisma();
    await controller(prisma).setConversationSubject({ conversationId: 'c-1', subject: TITLE }, md());

    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      type: 'conversation.subject_set',
      subject_kind: 'conversation',
      subject_id: 'c-1',
      actor_kind: 'user',
      actor_ref: 'op-1',
      payload_json: { source: 'manual' },
    });
  });

  it('⚠️ NEVER carries the title — it is a human’s words in an append-only store', async () => {
    const { prisma, transitions } = fakePrisma();
    await controller(prisma).setConversationSubject({ conversationId: 'c-1', subject: TITLE }, md());
    expect(JSON.stringify(transitions[0])).not.toContain('выплата');
  });

  it('a MANUAL set is distinguishable from an AUTOMATIC one in the stream', async () => {
    // The whole reason `subject_set_by` / `subject_set_at` are not columns (data-model §4): the answer
    // to "who named this and when" is a row in the stream, not duplicated bookkeeping on the hot row.
    const { prisma, transitions } = fakePrisma();
    await controller(prisma).setConversationSubject({ conversationId: 'c-1', subject: TITLE }, md());
    expect(transitions[0]!.payload_json).toEqual({ source: 'manual' });
    expect(transitions[0]!.occurred_at).toBeInstanceOf(Date);
  });

  it('carries the dimensions as they were, and one correlation id', async () => {
    const { prisma, transitions } = fakePrisma();
    await controller(prisma).setConversationSubject({ conversationId: 'c-1', subject: TITLE }, md());
    expect(transitions[0]!.dims_json).toMatchObject({ brand: 'brand-a', channel: 'chat' });
    expect(typeof transitions[0]!.correlation_id).toBe('string');
  });

  it('publishes NO automation event — a title is a label, not a trigger', async () => {
    // `noEvents()` throws on every publisher method, so reaching one fails this loudly. A rule able to
    // react to a rename is the cascade feature 014 bounded by construction.
    const { prisma } = fakePrisma();
    await expect(
      controller(prisma).setConversationSubject({ conversationId: 'c-1', subject: TITLE }, md()),
    ).resolves.toBeDefined();
  });
});
