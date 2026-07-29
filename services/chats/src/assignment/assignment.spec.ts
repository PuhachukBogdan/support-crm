import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { ConversationRepository } from '../conversation/conversation.repository';
import { AssignmentRepository } from './assignment.repository';
import { AssignmentWriteController } from './assignment.grpc.controller';

/**
 * T014 (feature 013, US1) — assign / reassign / unassign. Every path goes through the
 * account-scoped client (`forAccount`), the target conversation is brand resource-checked before
 * any mutation, and the operator id is stored as a soft ref (no Users call — research R8).
 *
 * FAILS before the assignment module exists, PASSES after.
 */

function detailRow(over: Record<string, unknown> = {}) {
  return {
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
  };
}

function fakePrisma(over: Record<string, jest.Mock> = {}) {
  const conversation = {
    findFirst: over.findFirst ?? jest.fn().mockResolvedValue(detailRow()),
    updateMany: over.updateMany ?? jest.fn().mockResolvedValue({ count: 1 }),
    create: jest.fn(),
    findMany: jest.fn(),
  };
  const forAccount = jest.fn().mockReturnValue({ conversation });
  return { prisma: { forAccount } as unknown as PrismaService, conversation, forAccount };
}

function md(accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
  return m;
}

const build = (prisma: PrismaService) => {
  const convRepo = new ConversationRepository(prisma);
  return new AssignmentWriteController(new AssignmentRepository(prisma, convRepo), convRepo);
};

describe('AssignConversation (US1)', () => {
  it('assigns an operator and returns the updated conversation', async () => {
    const { prisma, conversation, forAccount } = fakePrisma({
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(detailRow()) // resource check
        .mockResolvedValueOnce(detailRow({ assignee_operator_id: 'op-a' })), // re-read
    });
    const res = await build(prisma).assignConversation(
      { conversationId: 'c1', operatorId: 'op-a' },
      md('acc-1'),
    );

    expect(forAccount).toHaveBeenCalledWith('acc-1');
    expect(conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { assignee_operator_id: 'op-a' },
    });
    expect(res).toMatchObject({ id: 'c1', assigneeOperatorId: 'op-a' });
  });

  it('reassigns to a different operator (replacing the previous one)', async () => {
    const { prisma, conversation } = fakePrisma({
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(detailRow({ assignee_operator_id: 'op-a' }))
        .mockResolvedValueOnce(detailRow({ assignee_operator_id: 'op-b' })),
    });
    const res = await build(prisma).assignConversation(
      { conversationId: 'c1', operatorId: 'op-b' },
      md('acc-1'),
    );
    expect(conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { assignee_operator_id: 'op-b' },
    });
    expect(res).toMatchObject({ assigneeOperatorId: 'op-b' });
  });

  it('unassigns when operator_id is empty — stores NULL, not the empty string', async () => {
    const { prisma, conversation } = fakePrisma({
      findFirst: jest
        .fn()
        .mockResolvedValueOnce(detailRow({ assignee_operator_id: 'op-a' }))
        .mockResolvedValueOnce(detailRow({ assignee_operator_id: null })),
    });
    const res = await build(prisma).assignConversation(
      { conversationId: 'c1', operatorId: '' },
      md('acc-1'),
    );
    expect(conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { assignee_operator_id: null },
    });
    expect(res).toMatchObject({ assigneeOperatorId: '' }); // wire renders null as ""
  });

  it('is NOT_FOUND for a conversation absent in this account — and writes nothing', async () => {
    const { prisma, conversation } = fakePrisma({ findFirst: jest.fn().mockResolvedValue(null) });
    await expect(
      build(prisma).assignConversation({ conversationId: 'nope', operatorId: 'op-a' }, md()),
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

  it('rejects a blank conversation id before touching the database', async () => {
    const { prisma, conversation, forAccount } = fakePrisma();
    await expect(
      build(prisma).assignConversation({ conversationId: '', operatorId: 'op-a' }, md()),
    ).rejects.toBeInstanceOf(RpcException);
    expect(forAccount).not.toHaveBeenCalled();
    expect(conversation.updateMany).not.toHaveBeenCalled();
  });

  it('never resolves the operator through another service (soft ref only — R8)', async () => {
    // The repository takes only Prisma + the conversation repo; no Users client is reachable.
    const { prisma } = fakePrisma();
    const repo = new AssignmentRepository(prisma, new ConversationRepository(prisma));
    expect(Object.values(repo as unknown as Record<string, unknown>)).not.toContainEqual(
      expect.objectContaining({ getService: expect.any(Function) }),
    );
  });
});

describe('AssignmentRepository.setAssignee', () => {
  it('returns null (not a throw) when the row is outside the account', async () => {
    const { prisma } = fakePrisma({ updateMany: jest.fn().mockResolvedValue({ count: 0 }) });
    const repo = new AssignmentRepository(prisma, new ConversationRepository(prisma));
    await expect(repo.setAssignee('acc-1', 'c1', 'op-a')).resolves.toBeNull();
  });

  it('always goes through forAccount — never the raw client', async () => {
    const { prisma, forAccount } = fakePrisma();
    const repo = new AssignmentRepository(prisma, new ConversationRepository(prisma));
    await repo.setAssignee('acc-9', 'c1', null);
    expect(forAccount).toHaveBeenCalledWith('acc-9');
  });
});
