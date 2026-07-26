import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { ConversationRepository } from './conversation.repository';
import { ConversationReadController } from './conversation.grpc.controller';
import { ConversationWriteController } from './conversation.write.controller';

function detailRow(over: Partial<Record<string, unknown>> = {}) {
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
    created_at: new Date('2026-07-22T10:00:00.000Z'),
    updated_at: new Date('2026-07-22T10:00:00.000Z'),
    ...over,
  };
}

function fakePrisma(over: Record<string, jest.Mock> = {}) {
  const conversation = {
    findFirst: over.findFirst ?? jest.fn(),
    updateMany: over.updateMany ?? jest.fn(),
    create: over.create ?? jest.fn(),
    findMany: over.findMany ?? jest.fn(),
  };
  const forAccount = jest.fn().mockReturnValue({ conversation });
  return { prisma: { forAccount } as unknown as PrismaService, conversation, forAccount };
}

function md(accountId = 'acc-1', brands?: string[]): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
  if (brands) m.set('x-actor-brands', brands.join(','));
  return m;
}

describe('GetConversation access (US1, Principle I + brand-scope R3)', () => {
  it('returns detail for a conversation in a permitted brand', async () => {
    const { prisma, forAccount } = fakePrisma({ findFirst: jest.fn().mockResolvedValue(detailRow()) });
    const ctrl = new ConversationReadController(new ConversationRepository(prisma));
    const res = await ctrl.getConversation({ id: 'c1' }, md('acc-1', ['brand-a']));
    expect(forAccount).toHaveBeenCalledWith('acc-1');
    expect(res).toMatchObject({ id: 'c1', brandId: 'brand-a', status: 'CONVERSATION_STATUS_OPEN' });
  });

  it('is NOT_FOUND when the id is absent in this account (no cross-account read)', async () => {
    const { prisma } = fakePrisma({ findFirst: jest.fn().mockResolvedValue(null) });
    const ctrl = new ConversationReadController(new ConversationRepository(prisma));
    await expect(ctrl.getConversation({ id: 'other-acct' }, md('acc-1', ['brand-a']))).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('is NOT_FOUND (no existence disclosure) for a brand the caller may not serve', async () => {
    const { prisma } = fakePrisma({
      findFirst: jest.fn().mockResolvedValue(detailRow({ brand_id: 'brand-forbidden' })),
    });
    const ctrl = new ConversationReadController(new ConversationRepository(prisma));
    await expect(ctrl.getConversation({ id: 'c1' }, md('acc-1', ['brand-a']))).rejects.toBeInstanceOf(
      RpcException,
    );
  });
});

describe('Conversation writes (US1)', () => {
  it('CreateConversation refuses a brand outside the caller scope', async () => {
    const { prisma, conversation } = fakePrisma();
    const ctrl = new ConversationWriteController(new ConversationRepository(prisma));
    await expect(
      ctrl.createConversation({ brandId: 'brand-z' }, md('acc-1', ['brand-a'])),
    ).rejects.toBeInstanceOf(RpcException);
    expect(conversation.create).not.toHaveBeenCalled();
  });

  it('SetConversationStatus rejects an invalid status', async () => {
    const { prisma } = fakePrisma();
    const ctrl = new ConversationWriteController(new ConversationRepository(prisma));
    await expect(
      ctrl.setConversationStatus({ conversationId: 'c1', status: 'CONVERSATION_STATUS_UNSPECIFIED' }, md()),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('SetConversationStatus updates a permitted conversation and returns the new state', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(detailRow({ status: 'open' })) // brand/existence check
      .mockResolvedValueOnce(detailRow({ status: 'resolved' })); // re-read after update
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { prisma } = fakePrisma({ findFirst, updateMany });
    const ctrl = new ConversationWriteController(new ConversationRepository(prisma));
    const res = await ctrl.setConversationStatus(
      { conversationId: 'c1', status: 'CONVERSATION_STATUS_RESOLVED' },
      md('acc-1', ['brand-a']),
    );
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { status: 'resolved' } });
    expect(res.status).toBe('CONVERSATION_STATUS_RESOLVED');
  });
});
