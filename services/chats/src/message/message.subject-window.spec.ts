import type { PrismaService } from '../prisma.service';
import { MessageRepository, type PostInput } from './message.repository';
import { TransitionRecorder } from '../transition/transition.recorder';
import { userActor } from '../transition/conversation-transitions';

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


/**
 * T030 / T030a (feature 023, roadmap 4.18 + 4.8a) — the title window ON THE WRITE PATH.
 *
 * ⚠️ Why this file exists as well as `subject.derive.spec.ts`. The decision is pure and tested there;
 * what is tested HERE is the wiring, and the wiring is where this feature already went wrong once:
 * the first-public-reply transition read the conversation row **after** the stamp update that sets
 * `last_outbound_at`, so its own condition could never be true. Every unit test stayed green, because
 * a fake `findFirst` answers whatever it was told regardless of the `updateMany` before it. Only a
 * live run would have shown it.
 *
 * So this fake **behaves like a database**: `updateMany` mutates the row, and `findFirst` reads the
 * row as it is at that moment. That is the only kind of fake that can catch an ordering defect.
 */

const CREATED_AT = new Date('2026-08-04T10:00:00.000Z');
const REAL_QUESTION = 'не пришёл депозит со вчера, что делать';
const ACTOR = userActor('op-1', 'corr-1');

interface Row {
  id: string;
  brand_id: string;
  channel: string | null;
  status: string | null;
  assignee_operator_id: string | null;
  last_outbound_at: Date | null;
  subject: string | null;
  subject_source: string | null;
  category: string | null;
}

function db(over: Partial<Row> = {}, playerMessages = 0) {
  const row: Row = {
    id: 'c-1',
    brand_id: 'brand-a',
    channel: 'chat',
    status: 'open',
    assignee_operator_id: null,
    last_outbound_at: null,
    subject: null,
    subject_source: null,
    category: null,
    ...over,
  };
  let players = playerMessages;

  const transitions: Array<Record<string, unknown>> = [];
  const count = jest.fn(() => Promise.resolve(players));

  const scoped = {
    message: {
      create: jest.fn((args: { data: Record<string, unknown> }) => {
        if (args.data.author_type === 'player' && args.data.private === false) players += 1;
        return Promise.resolve({
          id: 'm-new',
          conversation_id: args.data.conversation_id,
          author_type: args.data.author_type,
          author_id: args.data.author_id,
          body: args.data.body,
          private: args.data.private,
          mentions: [],
          created_at: CREATED_AT,
        });
      }),
      count,
    },
    conversation: {
      // Reads the row AS IT IS NOW — the whole point of this fake.
      findFirst: jest.fn(() => Promise.resolve({ ...row })),
      updateMany: jest.fn((args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        // Honour the window predicate: a closed window matches zero rows.
        if ('subject_source' in args.where && args.where.subject_source !== row.subject_source) {
          return Promise.resolve({ count: 0 });
        }
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
    messageAttachment: { createMany: jest.fn(() => Promise.resolve({ count: 0 })) },
  } as Record<string, unknown>;

  (scoped as { $transaction: unknown }).$transaction = (fn: (tx: unknown) => Promise<unknown>) =>
    fn(scoped);

  const prisma = { forAccount: jest.fn().mockReturnValue(scoped) } as unknown as PrismaService;
  return { prisma, row, transitions, count };
}

const post = (over: Partial<PostInput> = {}): PostInput => ({
  conversationId: 'c-1',
  authorType: 'player',
  authorId: 'p-1',
  body: REAL_QUESTION,
  isPrivate: false,
  mentions: [],
  ...over,
});

const repo = (prisma: PrismaService) => new MessageRepository(prisma, new TransitionRecorder(), noOutbox());

const typesOf = (transitions: Array<Record<string, unknown>>) => transitions.map((t) => t.type);

describe('the first public reply is recorded — regression for the read-after-write defect', () => {
  it('records `conversation.first_public_reply` on the FIRST public staff reply', async () => {
    const { prisma, transitions } = db();
    await repo(prisma).post('acc-1', post({ authorType: 'operator', body: 'looking' }), ACTOR);

    expect(typesOf(transitions)).toContain('conversation.first_public_reply');
    const t = transitions.find((x) => x.type === 'conversation.first_public_reply')!;
    expect(t.payload_json).toEqual({ messageId: 'm-new' });
  });

  it('does NOT record it on the second reply — the stamp is already set', async () => {
    const { prisma, transitions } = db({ last_outbound_at: new Date('2026-08-04T09:00:00.000Z') });
    await repo(prisma).post('acc-1', post({ authorType: 'operator', body: 'again' }), ACTOR);

    expect(typesOf(transitions)).not.toContain('conversation.first_public_reply');
  });

  it('a PRIVATE note is not a public reply', async () => {
    const { prisma, transitions } = db();
    await repo(prisma).post(
      'acc-1',
      post({ authorType: 'operator', body: 'internal', isPrivate: true }),
      ACTOR,
    );
    expect(typesOf(transitions)).not.toContain('conversation.first_public_reply');
  });
});

describe('the title window on the write path (FR-014…FR-019)', () => {
  it('a substantive first customer message becomes the candidate, window still OPEN', async () => {
    const { prisma, row, transitions } = db();
    await repo(prisma).post('acc-1', post(), ACTOR);

    expect(row.subject).toBe(REAL_QUESTION);
    expect(row.subject_source).toBeNull(); // still listening
    expect(typesOf(transitions)).not.toContain('conversation.subject_set');
  });

  it('the customer’s 3rd message CLOSES the window and records the transition', async () => {
    const { prisma, row, transitions } = db({ subject: REAL_QUESTION }, 2);
    await repo(prisma).post('acc-1', post({ body: 'ну что там' }), ACTOR);

    expect(row.subject).toBe(REAL_QUESTION);
    expect(row.subject_source).toBe('auto');
    const t = transitions.find((x) => x.type === 'conversation.subject_set')!;
    expect(t.payload_json).toEqual({ source: 'auto' });
  });

  it('⚠️ the transition carries the SOURCE and never the title', async () => {
    const { prisma, transitions } = db({ subject: REAL_QUESTION }, 2);
    await repo(prisma).post('acc-1', post({ body: 'ну что там' }), ACTOR);

    const t = transitions.find((x) => x.type === 'conversation.subject_set')!;
    expect(JSON.stringify(t)).not.toContain('депозит');
  });

  it('the first staff reply closes the window', async () => {
    const { prisma, row } = db({ subject: REAL_QUESTION });
    await repo(prisma).post('acc-1', post({ authorType: 'operator', body: 'looking' }), ACTOR);

    expect(row.subject_source).toBe('auto');
  });

  it('closing with nothing usable stores NULL and still closes (FR-019)', async () => {
    const { prisma, row, transitions } = db({}, 2);
    await repo(prisma).post('acc-1', post({ body: 'привет' }), ACTOR);

    expect(row.subject).toBeNull();
    expect(row.subject_source).toBe('auto');
    expect(typesOf(transitions)).toContain('conversation.subject_set');
  });

  it('a MANUAL title is untouched, and the count is never even read (FR-022)', async () => {
    const { prisma, row, transitions, count } = db({
      subject: 'выплата задерживается',
      subject_source: 'manual',
    });
    await repo(prisma).post('acc-1', post({ body: REAL_QUESTION }), ACTOR);

    expect(row.subject).toBe('выплата задерживается');
    expect(row.subject_source).toBe('manual');
    expect(count).not.toHaveBeenCalled();
    expect(typesOf(transitions)).not.toContain('conversation.subject_set');
  });

  it('an already-auto title is untouched by any later message (FR-018)', async () => {
    const { prisma, row, count } = db({ subject: 'старый заголовок', subject_source: 'auto' }, 1);
    await repo(prisma).post('acc-1', post({ body: REAL_QUESTION }), ACTOR);

    expect(row.subject).toBe('старый заголовок');
    expect(count).not.toHaveBeenCalled();
  });

  it('a private note from the customer neither counts nor names anything', async () => {
    const { prisma, row, count } = db();
    await repo(prisma).post('acc-1', post({ isPrivate: true }), ACTOR);

    expect(row.subject).toBeNull();
    expect(count).not.toHaveBeenCalled();
  });

  it('an attachment-only opener names the KIND, never the file', async () => {
    const { prisma, row } = db();
    await repo(prisma).post('acc-1', post({ body: '', attachmentKind: 'image' }), ACTOR);

    expect(row.subject).toBe('image');
  });

  it('the closing update repeats the window predicate, so a race cannot double-close', async () => {
    const { prisma } = db({ subject: REAL_QUESTION }, 2);
    const scoped = (prisma.forAccount as jest.Mock)('acc-1') as {
      conversation: { updateMany: jest.Mock };
    };
    await repo(prisma).post('acc-1', post({ body: 'ну что там' }), ACTOR);

    const closing = scoped.conversation.updateMany.mock.calls
      .map((c) => c[0] as { where: Record<string, unknown>; data: Record<string, unknown> })
      .find((c) => c.data.subject_source === 'auto')!;
    expect(closing.where).toMatchObject({ id: 'c-1', subject_source: null });
  });
});
