import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { ConversationRepository } from '../conversation/conversation.repository';
import { LabelsRepository } from './labels.repository';
import { LabelsController } from './labels.grpc.controller';

/**
 * T020 (feature 013, US2) — labels: idempotent attach/detach (SC-006), managed create with a
 * per-account unique name, account+brand scoping on every path.
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
    findMany: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  };
  const label = {
    findMany: over.labelFindMany ?? jest.fn().mockResolvedValue([]),
    findFirst: over.labelFindFirst ?? jest.fn().mockResolvedValue({ id: 'l1' }),
    create: over.labelCreate ?? jest.fn().mockResolvedValue({ id: 'l1', name: 'x', color: null }),
  };
  const conversationLabel = {
    findMany: over.linkFindMany ?? jest.fn().mockResolvedValue([]),
    upsert: over.linkUpsert ?? jest.fn().mockResolvedValue({}),
    deleteMany: over.linkDeleteMany ?? jest.fn().mockResolvedValue({ count: 0 }),
  };
  const forAccount = jest.fn().mockReturnValue({ conversation, label, conversationLabel });
  return {
    prisma: { forAccount } as unknown as PrismaService,
    conversation,
    label,
    conversationLabel,
    forAccount,
  };
}

function md(accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
  return m;
}

const build = (prisma: PrismaService) =>
  new LabelsController(new LabelsRepository(prisma), new ConversationRepository(prisma));

describe('Labels — attach / detach idempotency (SC-006)', () => {
  it('attach upserts the link, so attaching twice is a no-op', async () => {
    const { prisma, conversationLabel } = fakePrisma();
    const ctrl = build(prisma);
    await ctrl.attachLabel({ conversationId: 'c1', labelId: 'l1' }, md('acc-1'));
    await ctrl.attachLabel({ conversationId: 'c1', labelId: 'l1' }, md('acc-1'));

    expect(conversationLabel.upsert).toHaveBeenCalledTimes(2);
    const call = conversationLabel.upsert.mock.calls[0][0] as Record<string, unknown>;
    expect(call.update).toEqual({}); // re-attach changes nothing
    expect(call.create).toEqual({ conversation_id: 'c1', label_id: 'l1' });
  });

  it('detach uses deleteMany, so detaching an absent link is a no-op (not an error)', async () => {
    const { prisma, conversationLabel } = fakePrisma({
      linkDeleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    });
    await expect(
      build(prisma).detachLabel({ conversationId: 'c1', labelId: 'l1' }, md('acc-1')),
    ).resolves.toEqual({ ok: true });
    expect(conversationLabel.deleteMany).toHaveBeenCalledWith({
      where: { conversation_id: 'c1', label_id: 'l1' },
    });
  });
});

describe('Labels — scoping and access', () => {
  it('every operation goes through forAccount (Principle I)', async () => {
    const { prisma, forAccount } = fakePrisma();
    await build(prisma).listLabels({}, md('acc-7'));
    expect(forAccount).toHaveBeenCalledWith('acc-7');
  });

  it('refuses to attach a label that does not resolve inside the account (no disclosure)', async () => {
    const { prisma, conversationLabel } = fakePrisma({
      labelFindFirst: jest.fn().mockResolvedValue(null), // foreign / nonexistent label
    });
    await expect(
      build(prisma).attachLabel(
        { conversationId: 'c1', labelId: 'foreign-label' },
        md('acc-1'),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(conversationLabel.upsert).not.toHaveBeenCalled();
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

  it('is NOT_FOUND for a conversation absent in this account', async () => {
    const { prisma } = fakePrisma({ convFindFirst: jest.fn().mockResolvedValue(null) });
    await expect(
      build(prisma).listConversationLabels({ conversationId: 'nope' }, md()),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('rejects a blank conversation id before any query', async () => {
    const { prisma, conversation } = fakePrisma();
    await expect(
      build(prisma).attachLabel({ conversationId: '  ', labelId: 'l1' }, md()),
    ).rejects.toBeInstanceOf(RpcException);
    expect(conversation.findFirst).not.toHaveBeenCalled();
  });
});

describe('Labels — managed create (unique per account)', () => {
  it('creates a label with the account id and a normalised name', async () => {
    const { prisma, label } = fakePrisma({
      labelCreate: jest.fn().mockResolvedValue({ id: 'l9', name: 'urgent', color: '#fff' }),
    });
    const res = await build(prisma).createLabel({ name: '  urgent  ', color: '#fff' }, md('acc-1'));
    expect(label.create.mock.calls[0][0]).toMatchObject({
      data: { account_id: 'acc-1', name: 'urgent', color: '#fff' },
    });
    expect(res).toEqual({ id: 'l9', name: 'urgent', color: '#fff' });
  });

  it('renders an unset colour as "" on the wire (never null)', async () => {
    const { prisma } = fakePrisma({
      labelCreate: jest.fn().mockResolvedValue({ id: 'l9', name: 'plain', color: null }),
    });
    await expect(build(prisma).createLabel({ name: 'plain' }, md())).resolves.toEqual({
      id: 'l9',
      name: 'plain',
      color: '',
    });
  });

  it('conflicts (never duplicates) when the name already exists in the account', async () => {
    const { prisma } = fakePrisma({
      labelCreate: jest.fn().mockRejectedValue(new Error('unique constraint failed')),
    });
    await expect(build(prisma).createLabel({ name: 'dup' }, md())).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('rejects a blank name', async () => {
    const { prisma, label } = fakePrisma();
    await expect(build(prisma).createLabel({ name: '   ' }, md())).rejects.toBeInstanceOf(
      RpcException,
    );
    expect(label.create).not.toHaveBeenCalled();
  });
});
