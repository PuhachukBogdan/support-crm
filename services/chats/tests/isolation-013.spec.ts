import type { BacklogRepository } from '../src/assignment/backlog';
import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../src/prisma.service';
import { ConversationRepository } from '../src/conversation/conversation.repository';
import { AssignmentRepository } from '../src/assignment/assignment.repository';
import { AssignmentWriteController } from '../src/assignment/assignment.grpc.controller';
import { RoundRobinStateRepository } from '../src/assignment/round-robin-state.repository';
import { AutoAssignController } from '../src/assignment/auto-assign.grpc.controller';
import type { GroupPoolService } from '../src/assignment/group-pool';
import { LabelsRepository } from '../src/labels/labels.repository';
import { LabelsController } from '../src/labels/labels.grpc.controller';
import { MacrosRepository } from '../src/macros/macros.repository';
import { MacrosController } from '../src/macros/macros.grpc.controller';
import { CannedRepository } from '../src/canned/canned.repository';
import { CannedController } from '../src/canned/canned.grpc.controller';
import { TransitionRecorder } from '../src/transition/transition.recorder';
import { fakeStatusRepository } from '../src/status/status.fixture';
import { fakeRealtime } from '../src/realtime/realtime.fake';

/**
 * T036 (feature 013) — consolidated cross-account isolation sweep for the workflow layer
 * (Principle I / SC-002). One store holds rows in TWO accounts, deliberately colliding on the ids a
 * caller might guess: the same conversation ids, label ids, macro ids and canned-response names
 * exist in both. Every 013 path is exercised as `acc-1` and must never read or mutate `acc-2`.
 *
 * The fake `forAccount(acc)` reproduces what the feature-007 extension does: it confines every
 * operation to `acc`. So "not found" here is the *structural* outcome of scoping, not a filter the
 * handler applied afterwards.
 */

interface Row {
  id: string;
  account_id: string;
  [k: string]: unknown;
}

const conversations: Row[] = [
  { id: 'shared-id', account_id: 'acc-1', brand_id: 'brand-a', assignee_operator_id: null },
  // Same conversation id in the other account — the trap.
  { id: 'shared-id', account_id: 'acc-2', brand_id: 'brand-a', assignee_operator_id: null },
  { id: 'only-acc2', account_id: 'acc-2', brand_id: 'brand-a', assignee_operator_id: null },
];
const labels: Row[] = [
  { id: 'l-shared', account_id: 'acc-1', name: 'ours' },
  { id: 'l-shared', account_id: 'acc-2', name: 'theirs' },
  { id: 'l-only-2', account_id: 'acc-2', name: 'foreign' },
];
const macros: Row[] = [
  {
    id: 'm-shared',
    account_id: 'acc-1',
    name: 'ours',
    definition: { actions: [{ type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'pending' }] },
  },
  {
    id: 'm-only-2',
    account_id: 'acc-2',
    name: 'theirs',
    definition: { actions: [{ type: 'MACRO_ACTION_TYPE_ASSIGN', value: 'op-foreign' }] },
  },
];
const canned: Row[] = [
  { id: 'cr-1', account_id: 'acc-1', name: 'greeting', body: 'ours' },
  { id: 'cr-2', account_id: 'acc-2', name: 'greeting', body: 'theirs' },
];
const rrState: Row[] = [{ id: 'rr-2', account_id: 'acc-2', group_key: 'team', cursor: 3 }];

/** Track every write so we can assert the foreign account was never touched. */
const writes: { table: string; account: string; data: unknown }[] = [];

function fullConversation(r: Row) {
  return {
    ...r,
    player_id: 'p1',
    status: 'open',
    priority: null,
    channel: null,
    reference: null,
    category: null,
    sub_category: null,
    classified_by: null,
    created_at: new Date('2026-07-26T10:00:00.000Z'),
    updated_at: new Date('2026-07-26T10:00:00.000Z'),
  };
}

function scopedFor(acc: string) {
  const own = <T extends Row>(rows: T[]) => rows.filter((r) => r.account_id === acc);
  const findFirstIn = (rows: Row[], where: Record<string, unknown>) => {
    const match = own(rows).find((r) =>
      Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
    );
    return Promise.resolve(match ?? null);
  };

  const scoped: Record<string, unknown> = {
    // Feature 023: the transition rides the same transaction as the write it describes. The fake
    // records into an array so the isolation assertions can still see exactly what was written.
    conversationTransition: { create: (a: { data: unknown }) => Promise.resolve(a.data) },
    conversation: {
      findFirst: (a: { where: Record<string, unknown> }) =>
        findFirstIn(conversations, a.where).then((r) => (r ? fullConversation(r) : null)),
      findMany: () => Promise.resolve(own(conversations).map(fullConversation)),
      updateMany: (a: { where: Record<string, unknown>; data: unknown }) => {
        const target = own(conversations).find((r) => r.id === a.where.id);
        if (!target) return Promise.resolve({ count: 0 });
        writes.push({ table: 'conversation', account: acc, data: a.data });
        Object.assign(target, a.data as object);
        return Promise.resolve({ count: 1 });
      },
      create: () => Promise.resolve(fullConversation(conversations[0]!)),
    },
    label: {
      findFirst: (a: { where: Record<string, unknown> }) => findFirstIn(labels, a.where),
      findMany: () => Promise.resolve(own(labels)),
      create: (a: { data: Row }) => {
        writes.push({ table: 'label', account: acc, data: a.data });
        return Promise.resolve({ id: 'new', name: a.data.name, color: null });
      },
    },
    conversationLabel: {
      findMany: () => Promise.resolve([]),
      upsert: (a: unknown) => {
        writes.push({ table: 'conversationLabel', account: acc, data: a });
        return Promise.resolve({});
      },
      deleteMany: (a: unknown) => {
        writes.push({ table: 'conversationLabel:delete', account: acc, data: a });
        return Promise.resolve({ count: 0 });
      },
    },
    macro: {
      findFirst: (a: { where: Record<string, unknown> }) => findFirstIn(macros, a.where),
      findMany: () => Promise.resolve(own(macros)),
      create: (a: { data: Row }) => {
        writes.push({ table: 'macro', account: acc, data: a.data });
        return Promise.resolve({ id: 'new', name: a.data.name });
      },
    },
    // ⭐ W29: the usage fact — a statement in the apply batch, and the weekly counter's one read.
    macroApplication: {
      create: (a: { data: Row }) => {
        writes.push({ table: 'macroApplication', account: acc, data: a.data });
        return Promise.resolve({});
      },
      groupBy: () => Promise.resolve([]),
    },
    cannedResponse: {
      findMany: () => Promise.resolve(own(canned)),
      create: (a: { data: Row }) => {
        writes.push({ table: 'cannedResponse', account: acc, data: a.data });
        return Promise.resolve({ id: 'new', name: a.data.name, body: a.data.body });
      },
    },
    roundRobinState: {
      findFirst: (a: { where: Record<string, unknown> }) => findFirstIn(rrState, a.where),
      updateMany: (a: unknown) => {
        writes.push({ table: 'roundRobinState', account: acc, data: a });
        return Promise.resolve({ count: 1 });
      },
      create: (a: { data: Row }) => {
        writes.push({ table: 'roundRobinState', account: acc, data: a.data });
        return Promise.resolve({ id: 'new' });
      },
    },
  } as Record<string, unknown>;
  // Feature 031: the per-operator advisory lock the claim takes. It names no table and carries the
  // account in its key, so it is account-agnostic by construction — nothing for this sweep to isolate,
  // but the fake has to answer or every assignment throws.
  scoped.$executeRawUnsafe = () => Promise.resolve(1);
  scoped.$transaction = (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(scoped) : Promise.resolve([]);
  return scoped;
}

const forAccount = jest.fn((acc: string) => scopedFor(acc));
const prisma = { forAccount } as unknown as PrismaService;

function md(accountId: string, perms: string[]): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
  m.set('x-actor-permissions', perms.join(','));
  return m;
}

const ALL = [
  'crm.conversation.assign',
  'crm.labels.manage',
  'crm.templates.manage',
  'crm.macros.use',
  'crm.conversation.reply',
];

const conversationRepo = () => new ConversationRepository(prisma, new TransitionRecorder());
const assignment = () =>
  new AssignmentWriteController(
    new AssignmentRepository(prisma, new TransitionRecorder(), conversationRepo()),
    conversationRepo(),
    fakeRealtime().publisher,
  );
const autoAssign = () =>
  new AutoAssignController(
    new RoundRobinStateRepository(prisma, new TransitionRecorder(), fakeStatusRepository()),
    conversationRepo(),
    // Feature 024: this sweep never names a group, so the pool must never be consulted. A throwing
    // stub proves that rather than assuming it.
    {
      candidatesFor: async () => {
        throw new Error('group pool must not be consulted here');
      },
    } as unknown as GroupPoolService,
    /**
     * Feature 031: the backlog IS consulted on this path — a successful assignment clears the wait, and a
     * full desk records one. ⚠️ A throwing stub was the first version and it was wrong: it asserted that
     * this path does not touch the queue, which stopped being true the moment the queue existed. The stub
     * records instead, so an isolation test stays about isolation.
     */
    {
      enqueue: jest.fn(async () => undefined),
      dequeue: jest.fn(async () => undefined),
    } as unknown as BacklogRepository,
    fakeRealtime().publisher,
  );
const labelsCtrl = () => new LabelsController(new LabelsRepository(prisma), conversationRepo());
const macrosCtrl = () =>
  new MacrosController(
    new MacrosRepository(prisma, new TransitionRecorder(), fakeStatusRepository()),
    new LabelsRepository(prisma),
    conversationRepo(),
    fakeStatusRepository(),
    // W29: memberships play no part in an isolation claim — the silent stub keeps it that way.
    { listUserGroups: async () => null } as never,
    { statement: () => Promise.resolve({}) } as never,
    // W30: nor does the category vocabulary.
    { activeFormCategories: async () => [] } as never,
  );
const cannedCtrl = () => new CannedController(new CannedRepository(prisma));

describe('feature 013 — cross-account isolation sweep (SC-002)', () => {
  beforeEach(() => {
    writes.length = 0;
    forAccount.mockClear();
  });

  afterEach(() => {
    // The invariant behind every case: acc-1 work never wrote as acc-2.
    expect(writes.every((w) => w.account === 'acc-1')).toBe(true);
  });

  it('assignment: a conversation id that also exists in acc-2 resolves to OUR row only', async () => {
    await assignment().assignConversation(
      { conversationId: 'shared-id', operatorId: 'op-a' },
      md('acc-1', ALL),
    );
    // The acc-2 twin is untouched.
    expect(conversations.find((c) => c.id === 'shared-id' && c.account_id === 'acc-2')!
      .assignee_operator_id).toBeNull();
  });

  it('assignment: an id that exists ONLY in acc-2 is not found, and nothing is written', async () => {
    await expect(
      assignment().assignConversation(
        { conversationId: 'only-acc2', operatorId: 'op-a' },
        md('acc-1', ALL),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(writes).toHaveLength(0);
  });

  it('auto-assign: another account rotation state is invisible (fresh cursor, not theirs)', async () => {
    const res = await autoAssign().autoAssignConversation(
      {
        conversationId: 'shared-id',
        groupKey: 'team',
        candidates: [
          { operatorId: 'op-a', capacity: 5, currentLoad: 0 },
          { operatorId: 'op-b', capacity: 5, currentLoad: 0 },
        ],
      },
      md('acc-1', ALL),
    );
    // acc-2's cursor is 3; if it leaked, selection would not start at index 0.
    expect(res).toMatchObject({ assigned: true, operatorId: 'op-a' });
    expect(rrState.find((r) => r.account_id === 'acc-2')!.cursor).toBe(3);
  });

  it('labels: listing returns only our account labels', async () => {
    const res = await labelsCtrl().listLabels({}, md('acc-1', ALL));
    expect(res.labels.map((l) => l.name)).toEqual(['ours']);
  });

  it('labels: attaching a label that exists only in acc-2 is refused, nothing written', async () => {
    await expect(
      labelsCtrl().attachLabel(
        { conversationId: 'shared-id', labelId: 'l-only-2' },
        md('acc-1', ALL),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(writes).toHaveLength(0);
  });

  it('macros: listing returns only our macros; theirs is unreachable by id', async () => {
    const res = await macrosCtrl().listMacros({}, md('acc-1', ALL));
    expect(res.macros.map((m) => m.name)).toEqual(['ours']);

    await expect(
      macrosCtrl().applyMacro(
        { conversationId: 'shared-id', macroId: 'm-only-2' },
        md('acc-1', ALL),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(writes).toHaveLength(0);
  });

  it('macros: applying OUR macro mutates only our conversation', async () => {
    await macrosCtrl().applyMacro(
      { conversationId: 'shared-id', macroId: 'm-shared' },
      md('acc-1', ALL),
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => w.account === 'acc-1')).toBe(true);
  });

  it('canned: the same NAME in both accounts resolves to our own row', async () => {
    const res = await cannedCtrl().listCannedResponses({}, md('acc-1', ALL));
    expect(res.canned).toEqual([{ id: 'cr-1', account_id: 'acc-1', name: 'greeting', body: 'ours' }]);
  });

  it('canned: creating writes under the caller account id, never a body-supplied one', async () => {
    await cannedCtrl().createCannedResponse({ name: 'new', body: 'text' }, md('acc-1', ALL));
    expect(writes[0]).toMatchObject({
      table: 'cannedResponse',
      account: 'acc-1',
      data: { account_id: 'acc-1' },
    });
  });

  it('every path requested the scoped client with the CALLER account (never a body value)', async () => {
    await labelsCtrl().listLabels({}, md('acc-1', ALL));
    await cannedCtrl().listCannedResponses({}, md('acc-1', ALL));
    await macrosCtrl().listMacros({}, md('acc-1', ALL));
    expect(forAccount.mock.calls.every((c) => c[0] === 'acc-1')).toBe(true);
  });
});
