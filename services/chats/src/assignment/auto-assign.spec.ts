import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { ConversationRepository } from '../conversation/conversation.repository';
import { RoundRobinStateRepository } from './round-robin-state.repository';
import { TransitionRecorder } from '../transition/transition.recorder';
import {
  AutoAssignController,
  GROUP_ROUTING_NOT_AVAILABLE,
  NO_OPERATOR_AVAILABLE,
} from './auto-assign.grpc.controller';

/**
 * T031 (feature 013, US3) — the auto-assign handler: rotation state persisted per (account, group),
 * the chosen operator actually assigned, and the two honest non-answers — nobody available, and
 * group routing not resolvable yet (spec US3 #3/#4). No Users call happens anywhere.
 */

const conversationRow = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  brand_id: 'brand-a',
  player_id: 'p1',
  status: 'open',
  priority: null,
  assignee_operator_id: null,
  channel: null,
  reference: null,
  category: null,
  sub_category: null,
  classified_by: null,
  created_at: new Date('2026-07-26T10:00:00.000Z'),
  updated_at: new Date('2026-07-26T10:00:00.000Z'),
  ...over,
});

function fakePrisma(over: Record<string, jest.Mock> = {}) {
  const conversation = {
    findFirst: over.convFindFirst ?? jest.fn().mockResolvedValue(conversationRow()),
    updateMany: over.convUpdateMany ?? jest.fn().mockResolvedValue({ count: 1 }),
    findMany: jest.fn(),
    create: jest.fn(),
  };
  const roundRobinState = {
    findFirst: over.rrFindFirst ?? jest.fn().mockResolvedValue(null),
    updateMany: over.rrUpdateMany ?? jest.fn().mockResolvedValue({ count: 1 }),
    create: over.rrCreate ?? jest.fn().mockResolvedValue({ id: 'rr1' }),
  };
  // Feature 023: auto-assignment is the FIFTH writer of assignee_operator_id, so the transition
  // rides this same interactive transaction.
  const conversationTransition = { create: over.transitionCreate ?? jest.fn() };
  const scoped = { conversation, roundRobinState, conversationTransition } as Record<string, unknown>;
  // Interactive $transaction: hand the callback the same scoped client (what Prisma does).
  //
  // Declared as a METHOD (not a detached arrow) and it asserts its own `this`, because feature-013
  // Track B caught exactly that: pulling `$transaction` into a variable lost the binding and Prisma
  // died on `this._engineConfig`. A standalone fake would never have noticed.
  const $transaction = jest.fn(function (this: unknown, cb: (tx: unknown) => unknown) {
    if (this !== scoped) {
      throw new TypeError('$transaction called without its client as `this` (lost binding)');
    }
    return cb(scoped);
  });
  scoped.$transaction = $transaction;
  const forAccount = jest.fn().mockReturnValue(scoped);
  return {
    prisma: { forAccount } as unknown as PrismaService,
    conversation,
    roundRobinState,
    conversationTransition,
    $transaction,
    forAccount,
  };
}

function md(accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
  m.set('x-actor-permissions', 'crm.conversation.assign');
  return m;
}

const build = (prisma: PrismaService) =>
  new AutoAssignController(
    new RoundRobinStateRepository(prisma, new TransitionRecorder()),
    new ConversationRepository(prisma, new TransitionRecorder()),
  );

const cand = (operatorId: string, capacity = 5, currentLoad = 0) => ({
  operatorId,
  capacity,
  currentLoad,
});

describe('AutoAssignConversation — happy path', () => {
  it('assigns the first candidate on a fresh rotation and stores the cursor', async () => {
    const { prisma, conversation, roundRobinState } = fakePrisma();
    const res = await build(prisma).autoAssignConversation(
      { conversationId: 'c1', groupKey: 'team-a', candidates: [cand('op-a'), cand('op-b')] },
      md(),
    );

    expect(res).toMatchObject({ assigned: true, operatorId: 'op-a', reason: '' });
    expect(conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { assignee_operator_id: 'op-a' },
    });
    // First run for this group → the state row is created with the chosen index.
    expect(roundRobinState.create.mock.calls[0][0]).toMatchObject({
      data: { account_id: 'acc-1', group_key: 'team-a', cursor: 0 },
    });
  });

  it('resumes from the stored cursor and updates it in place', async () => {
    const { prisma, conversation, roundRobinState } = fakePrisma({
      rrFindFirst: jest.fn().mockResolvedValue({ id: 'rr1', cursor: 0 }),
    });
    const res = await build(prisma).autoAssignConversation(
      { conversationId: 'c1', groupKey: 'team-a', candidates: [cand('op-a'), cand('op-b')] },
      md(),
    );
    expect(res).toMatchObject({ assigned: true, operatorId: 'op-b' });
    expect(conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { assignee_operator_id: 'op-b' },
    });
    expect(roundRobinState.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'rr1' },
      data: { cursor: 1 },
    });
    expect(roundRobinState.create).not.toHaveBeenCalled();
  });

  it('skips an at-capacity candidate', async () => {
    const { prisma, conversation } = fakePrisma();
    const res = await build(prisma).autoAssignConversation(
      { conversationId: 'c1', candidates: [cand('full', 1, 1), cand('free', 3, 0)] },
      md(),
    );
    expect(res).toMatchObject({ assigned: true, operatorId: 'free' });
    expect(conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { assignee_operator_id: 'free' },
    });
  });

  it('defaults the group key so rotation still persists when the caller omits it', async () => {
    const { prisma, roundRobinState } = fakePrisma();
    await build(prisma).autoAssignConversation(
      { conversationId: 'c1', candidates: [cand('op-a')] },
      md(),
    );
    expect(roundRobinState.create.mock.calls[0][0]).toMatchObject({
      data: { group_key: 'default' },
    });
  });

  it('does the cursor read+write and the assignment in ONE transaction (concurrency)', async () => {
    const { prisma, $transaction } = fakePrisma();
    await build(prisma).autoAssignConversation(
      { conversationId: 'c1', candidates: [cand('op-a')] },
      md(),
    );
    expect($transaction).toHaveBeenCalledTimes(1);
  });

  // Track-B regression: `$transaction` MUST be invoked as a method on the client. The fake throws
  // when `this` is lost, which is what a detached `const tx = db.$transaction` would cause.
  it('calls $transaction as a method on the scoped client (keeps its binding)', async () => {
    const { prisma, $transaction } = fakePrisma();
    await expect(
      build(prisma).autoAssignConversation(
        { conversationId: 'c1', candidates: [cand('op-a')] },
        md(),
      ),
    ).resolves.toMatchObject({ assigned: true });
    expect($transaction.mock.instances[0]).toBe($transaction.mock.contexts?.[0] ?? $transaction.mock.instances[0]);
  });
});

describe('AutoAssignConversation — honest non-answers', () => {
  it('reports NO_OPERATOR_AVAILABLE and changes nothing when all are at capacity (US3 #3)', async () => {
    const { prisma, conversation, roundRobinState } = fakePrisma();
    const res = await build(prisma).autoAssignConversation(
      { conversationId: 'c1', candidates: [cand('a', 1, 1), cand('b', 2, 2)] },
      md(),
    );
    expect(res).toMatchObject({ assigned: false, operatorId: '', reason: NO_OPERATOR_AVAILABLE });
    expect(conversation.updateMany).not.toHaveBeenCalled();
    expect(roundRobinState.create).not.toHaveBeenCalled();
    expect(roundRobinState.updateMany).not.toHaveBeenCalled();
  });

  it('reports GROUP_ROUTING_NOT_AVAILABLE with no candidate set — never guesses (US3 #4)', async () => {
    const { prisma, conversation, $transaction } = fakePrisma();
    const res = await build(prisma).autoAssignConversation(
      { conversationId: 'c1', groupKey: 'team-a' },
      md(),
    );
    expect(res).toMatchObject({
      assigned: false,
      operatorId: '',
      reason: GROUP_ROUTING_NOT_AVAILABLE,
    });
    expect($transaction).not.toHaveBeenCalled();
    expect(conversation.updateMany).not.toHaveBeenCalled();
  });

  it('treats a candidate list of only blank operator ids as no candidate set', async () => {
    const { prisma } = fakePrisma();
    const res = await build(prisma).autoAssignConversation(
      { conversationId: 'c1', candidates: [{ operatorId: '   ', capacity: 5, currentLoad: 0 }] },
      md(),
    );
    expect(res.reason).toBe(GROUP_ROUTING_NOT_AVAILABLE);
  });
});

describe('AutoAssignConversation — scope & access', () => {
  it('is NOT_FOUND for a conversation absent in this account, and writes nothing', async () => {
    const { prisma, conversation } = fakePrisma({ convFindFirst: jest.fn().mockResolvedValue(null) });
    await expect(
      build(prisma).autoAssignConversation(
        { conversationId: 'nope', candidates: [cand('op-a')] },
        md(),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(conversation.updateMany).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ A test asserting NOT_FOUND "for a conversation in a brand the caller may not serve" stood here
   * and was REMOVED by feature 020's cleanup (ADR 0038 §1), along with the guard it covered.
   *
   * It passed for four phases while the production path could not reach that branch: `mayAccessBrand`
   * compared against a caller brand set that nothing ever populated, so it could only return true.
   * The test supplied the set by hand, and therefore proved the helper's arithmetic and nothing about
   * the product.
   *
   * There is ONE support department. A brand never decides who may see what — it is part of a
   * player's IDENTITY (feature 020) and a filter a caller may ask for.
   */

  it('requires a conversation id', async () => {
    const { prisma } = fakePrisma();
    await expect(
      build(prisma).autoAssignConversation({ conversationId: '  ' }, md()),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('scopes every query to the caller account', async () => {
    const { prisma, forAccount } = fakePrisma();
    await build(prisma).autoAssignConversation(
      { conversationId: 'c1', candidates: [cand('op-a')] },
      md('acc-42'),
    );
    expect(forAccount).toHaveBeenCalledWith('acc-42');
    expect(forAccount.mock.calls.every((c) => c[0] === 'acc-42')).toBe(true);
  });

  it('makes no cross-service call for candidates (they are caller-supplied — R3)', () => {
    // Two dependencies only: rotation state + conversations. A Users client would change arity.
    expect(AutoAssignController.length).toBe(2);
  });
});
