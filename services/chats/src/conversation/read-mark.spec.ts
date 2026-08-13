import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import type { SlaRepository } from '../sla/sla.repository';
import { PersonMembersClient } from '../person/person-members.client';
import { ConversationRepository } from './conversation.repository';
import { ConversationReadController } from './conversation.grpc.controller';
import { ReadMarkRepository } from './read-mark.repository';
import { TransitionRecorder } from '../transition/transition.recorder';
import { fakeStatusRepository } from '../status/status.fixture';
import {
  fakeOperatorIdentity,
  noOperatorIdentity,
  recordingReadMarks,
} from '../shared/operator-identity.fake';

/**
 * W5 (roadmap 4.19) — **opening a conversation IS the fact the agent rail stands on.**
 *
 * The rail is a view over three facts; this file pins the one W5 introduces: the read mark. What
 * matters is not that a row is written but WHOSE row, WHEN it may be written, and that the read it
 * rides on can never be harmed by it. The list-side filter (`opened_by_operator_id`) is pinned in the
 * last describe, against the where-clause the repository actually builds.
 */

const ROW = {
  id: 'c1',
  brand_id: 'brand-a',
  player_id: 'p1',
  status: 'open',
  priority: null,
  assignee_operator_id: 'op-1',
  channel: 'api',
  created_at: new Date('2026-08-01T10:00:00.000Z'),
  updated_at: new Date('2026-08-01T11:00:00.000Z'),
};

function fakePrisma(row: Record<string, unknown> | null = ROW) {
  const findFirst = jest.fn().mockResolvedValue(row);
  const findMany = jest.fn().mockResolvedValue(row ? [row] : []);
  const forAccount = jest.fn().mockReturnValue({ conversation: { findFirst, findMany } });
  return { prisma: { forAccount } as unknown as PrismaService, findFirst, findMany, forAccount };
}

const noSla = () =>
  ({
    conversationIdsByOutcome: jest.fn(async () => [] as string[]),
    getState: jest.fn(async () => null),
  }) as unknown as SlaRepository;

const noPortfolio = () =>
  ({
    attachedPlayersOfCaller: jest.fn(async () => {
      throw new Error('portfolio must not be consulted here');
    }),
  }) as unknown as PersonMembersClient;

function md(over: { preview?: boolean } = {}): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', 'acc-1');
  m.set('x-actor-user-id', 'u1');
  if (over.preview) m.set('x-is-preview', 'true');
  return m;
}

function build(opts: {
  prisma: PrismaService;
  identity?: ReturnType<typeof fakeOperatorIdentity>;
  marks?: ReadMarkRepository;
}) {
  return new ConversationReadController(
    new ConversationRepository(opts.prisma, new TransitionRecorder()),
    noSla(),
    noPortfolio(),
    fakeStatusRepository(),
    opts.identity ?? noOperatorIdentity(),
    opts.marks ?? recordingReadMarks().repo,
  );
}

describe('the mark is written for the CALLER, on a successful detail read', () => {
  it('records (account, conversation, caller-operator) — the subject is resolved, never a field', async () => {
    const { prisma } = fakePrisma();
    const { repo, reads } = recordingReadMarks();
    const ctrl = build({ prisma, identity: fakeOperatorIdentity('op-9'), marks: repo });

    await ctrl.getConversation({ id: 'c1' }, md());
    expect(reads).toEqual([{ accountId: 'acc-1', conversationId: 'c1', operatorId: 'op-9' }]);
  });

  it('a caller with NO operator identity leaves no mark — an absence, not an error', async () => {
    const { prisma } = fakePrisma();
    const { repo, reads } = recordingReadMarks();
    const ctrl = build({ prisma, identity: noOperatorIdentity(), marks: repo });

    await expect(ctrl.getConversation({ id: 'c1' }, md())).resolves.toMatchObject({ id: 'c1' });
    expect(reads).toHaveLength(0);
  });

  it('⚠️ NOT under preview — view-as must stay free of side effects', async () => {
    const { prisma } = fakePrisma();
    const { repo, reads } = recordingReadMarks();
    const ctrl = build({ prisma, identity: fakeOperatorIdentity('op-9'), marks: repo });

    await ctrl.getConversation({ id: 'c1' }, md({ preview: true }));
    expect(reads).toHaveLength(0);
  });

  it('⚠️ a REFUSED read marks nothing — a denied open did not happen', async () => {
    const { prisma } = fakePrisma(null); // not in this account
    const { repo, reads } = recordingReadMarks();
    const ctrl = build({ prisma, identity: fakeOperatorIdentity('op-9'), marks: repo });

    await expect(ctrl.getConversation({ id: 'nope' }, md())).rejects.toBeInstanceOf(RpcException);
    expect(reads).toHaveLength(0);
  });

  it('⚠️ a failing mark write cannot fail the read — the caller asked for the conversation', async () => {
    const { prisma } = fakePrisma();
    const broken = {
      recordRead: jest.fn(async () => {
        throw new Error('db blinked');
      }),
    } as unknown as ReadMarkRepository;
    const ctrl = build({ prisma, identity: fakeOperatorIdentity('op-9'), marks: broken });

    await expect(ctrl.getConversation({ id: 'c1' }, md())).resolves.toMatchObject({ id: 'c1' });
  });
});

describe('the rail’s list leg: opened_by_operator_id is an EXISTS over the marks', () => {
  it('lands in the where-clause as a relation predicate, beside the other filters', async () => {
    const { prisma, findMany } = fakePrisma();
    const ctrl = build({ prisma });

    await ctrl.listConversations(
      { assigneeOperatorId: 'op-9', openedByOperatorId: 'op-9', pageSize: 10 },
      md(),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          assignee_operator_id: 'op-9',
          read_marks: { some: { operator_id: 'op-9' } },
        }),
      }),
    );
  });

  it('absent ⇒ absent: no read-mark predicate sneaks into an unfiltered list', async () => {
    const { prisma, findMany } = fakePrisma();
    const ctrl = build({ prisma });

    await ctrl.listConversations({ pageSize: 10 }, md());
    const where = (findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where).not.toHaveProperty('read_marks');
  });
});

describe('the repository’s idempotence lives in the upsert, not in bookkeeping', () => {
  it('two reads are ONE row: keyed on (account, conversation, operator), first_opened_at untouched', async () => {
    const upsert: jest.Mock = jest.fn(async () => ({}));
    const prisma = {
      forAccount: jest.fn().mockReturnValue({ conversationReadMark: { upsert } }),
    } as unknown as PrismaService;
    const repo = new ReadMarkRepository(prisma);

    await repo.recordRead('acc-1', 'c1', 'op-9');
    await repo.recordRead('acc-1', 'c1', 'op-9');

    expect(upsert).toHaveBeenCalledTimes(2);
    const call = upsert.mock.calls[0][0] as unknown as {
      where: Record<string, unknown>;
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    // The unique key IS the idempotence; `create` never carries a time of its own (defaults), and
    // `update` touches ONLY last_read_at — so first_opened_at cannot be rewritten by any second read.
    expect(call.where).toHaveProperty('account_id_conversation_id_operator_id');
    expect(Object.keys(call.update)).toEqual(['last_read_at']);
    expect(call.create).toEqual({ account_id: 'acc-1', conversation_id: 'c1', operator_id: 'op-9' });
  });
});
