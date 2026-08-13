import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import type { DomainEventPublisher } from '../events/events.publisher';
import { ConversationRepository } from './conversation.repository';
import { ConversationWriteController } from './conversation.write.controller';
import { TransitionRecorder } from '../transition/transition.recorder';
import { fakeStatusRepository } from '../status/status.fixture';
import { fakeRealtime } from '../realtime/realtime.fake';
import { noInboxUnseen, noOperatorIdentity } from '../shared/operator-identity.fake';
import { priorityRank } from './urgency';

/**
 * `SetConversationPriority` (2026-08-10) — the write that did not exist.
 *
 * ── What is actually at risk here ────────────────────────────────────────────────────────────────
 * Not "does the word land in the column". Two things:
 *
 *  1. **The rank must move with the word.** `priority_rank` is what the urgency order sorts on
 *     (feature 031). A write that set the word alone would leave the list ordered by the PREVIOUS
 *     priority while the ticket's own field says otherwise — a wrong queue that looks right, which is
 *     the failure mode nobody reports because nothing on screen contradicts itself.
 *  2. **Clearing must work.** `''` is the state every conversation is created in, so a field that can
 *     be set and never returned to its initial value is a one-way door built by accident.
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
  priority: null as string | null,
  priority_rank: priorityRank(null),
  assignee_operator_id: null,
  channel: 'chat',
  created_at: new Date('2026-08-10T10:00:00.000Z'),
  updated_at: new Date('2026-08-10T10:00:00.000Z'),
  reference: null,
  category: null,
  sub_category: null,
  classified_by: null,
  subject: 'не приходит вывод',
  subject_source: 'source',
};

function fakePrisma(exists = true) {
  const row = { ...DETAIL };
  const updates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];

  const scoped = {
    conversation: {
      findFirst: jest.fn(() => Promise.resolve(exists ? { ...row } : null)),
      updateMany: jest.fn(
        (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          if (!exists) return Promise.resolve({ count: 0 });
          updates.push(args);
          Object.assign(row, args.data);
          return Promise.resolve({ count: 1 });
        },
      ),
    },
    conversationTransition: { create: jest.fn(() => Promise.resolve({})) },
  } as Record<string, unknown>;
  (scoped as { $transaction: unknown }).$transaction = (fn: (tx: unknown) => Promise<unknown>) =>
    fn(scoped);

  const prisma = { forAccount: jest.fn().mockReturnValue(scoped) } as unknown as PrismaService;
  return { prisma, row, updates, scoped };
}

/** Priority is a property automations READ, never a trigger — so this stub refuses to be called. */
function noEvents() {
  const unexpected = () => {
    throw new Error('setting a priority must not publish an automation event');
  };
  return { conversationCreated: unexpected, statusChanged: unexpected } as unknown as DomainEventPublisher;
}

const controller = (prisma: PrismaService) =>
  new ConversationWriteController(
    new ConversationRepository(prisma, new TransitionRecorder()),
    noEvents(),
    fakeStatusRepository(),
    {} as never,
    fakeRealtime().publisher,
    noInboxUnseen(),
    noOperatorIdentity(),
    // W30: the solve gate is not this spec's subject — an empty answer means no gate.
    { missingRequiredForSolve: async () => [] } as never,
  );

describe('SetConversationPriority — the word and its rank', () => {
  it('⭐ writes the priority AND its urgency rank in one statement', async () => {
    const { prisma, row, updates } = fakePrisma();
    const res = await controller(prisma).setConversationPriority(
      { conversationId: 'c-1', priority: 'high' },
      md(),
    );

    const write = updates.find((u) => 'priority' in u.data)!;
    // Both keys, one statement: there is no instant at which the queue disagrees with the field.
    expect(write.data).toEqual({ priority: 'high', priority_rank: priorityRank('high') });
    expect(row.priority).toBe('high');
    expect(res.priority).toBe('high');
  });

  it('⭐ an empty value CLEARS it, rank included — the state a ticket is created in', async () => {
    const { prisma, row, updates } = fakePrisma();
    await controller(prisma).setConversationPriority({ conversationId: 'c-1', priority: 'high' }, md());
    await controller(prisma).setConversationPriority({ conversationId: 'c-1', priority: '' }, md());

    const last = updates[updates.length - 1]!;
    expect(last.data).toEqual({ priority: null, priority_rank: priorityRank(null) });
    expect(row.priority).toBeNull();
  });

  it('refuses an unknown word rather than coercing it to a neighbour', async () => {
    // Guessing which of three priorities somebody meant is wrong in the direction that matters:
    // silently filing an urgent ticket as normal.
    const { prisma, updates } = fakePrisma();
    await expect(
      controller(prisma).setConversationPriority({ conversationId: 'c-1', priority: 'urgent' }, md()),
    ).rejects.toMatchObject({ error: { code: GrpcStatus.INVALID_ARGUMENT } });
    expect(updates).toHaveLength(0);
  });

  it('trims, so a value pasted with a space is not a refusal a person cannot see', async () => {
    const { prisma, row } = fakePrisma();
    await controller(prisma).setConversationPriority({ conversationId: 'c-1', priority: ' low ' }, md());
    expect(row.priority).toBe('low');
  });

  it('404s an unknown conversation, and reads the row BEFORE writing', async () => {
    const { prisma } = fakePrisma(false);
    await expect(
      controller(prisma).setConversationPriority({ conversationId: 'nope', priority: 'high' }, md()),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('is account-scoped — the caller never names the account', async () => {
    // Tenant isolation: `forAccount` comes from the metadata, and there is no field on the request
    // that could point the write at somebody else's row.
    const { prisma } = fakePrisma();
    await controller(prisma).setConversationPriority({ conversationId: 'c-1', priority: 'low' }, md('acc-9'));
    expect((prisma.forAccount as jest.Mock).mock.calls[0][0]).toBe('acc-9');
  });

  it('tells the open window to re-read itself', async () => {
    const realtime = fakeRealtime();
    const { prisma } = fakePrisma();
    const ctrl = new ConversationWriteController(
      new ConversationRepository(prisma, new TransitionRecorder()),
      noEvents(),
      fakeStatusRepository(),
      {} as never,
      realtime.publisher,
      noInboxUnseen(),
      noOperatorIdentity(),
      { missingRequiredForSolve: async () => [] } as never,
    );
    await ctrl.setConversationPriority({ conversationId: 'c-1', priority: 'high' }, md());
    expect(realtime.published).toContainEqual(
      expect.objectContaining({ kind: 'conversation.updated', conversationId: 'c-1' }),
    );
  });
});
