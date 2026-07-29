import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import type { SlaRepository } from '../sla/sla.repository';
import { ConversationRepository } from './conversation.repository';
import { ConversationReadController } from './conversation.grpc.controller';
import type { DomainEventPublisher } from '../events/events.publisher';
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

/**
 * Feature 014 added the SLA repository to the read controller (the `slaOutcome` inbox filter and the
 * first-reply state on the detail). These specs predate it and are about account/brand scope + paging,
 * so it is stubbed: no filter requested ⇒ never consulted; no clock ⇒ no state on the detail.
 */
function noSla() {
  return {
    conversationIdsByOutcome: jest.fn(async () => [] as string[]),
    getState: jest.fn(async () => null),
  } as unknown as SlaRepository;
}

describe('GetConversation access (US1, Principle I + brand-scope R3)', () => {
  it('returns detail for a conversation in a permitted brand', async () => {
    const { prisma, forAccount } = fakePrisma({ findFirst: jest.fn().mockResolvedValue(detailRow()) });
    const ctrl = new ConversationReadController(new ConversationRepository(prisma), noSla());
    const res = await ctrl.getConversation({ id: 'c1' }, md('acc-1', ['brand-a']));
    expect(forAccount).toHaveBeenCalledWith('acc-1');
    expect(res).toMatchObject({ id: 'c1', brandId: 'brand-a', status: 'CONVERSATION_STATUS_OPEN' });
  });

  it('is NOT_FOUND when the id is absent in this account (no cross-account read)', async () => {
    const { prisma } = fakePrisma({ findFirst: jest.fn().mockResolvedValue(null) });
    const ctrl = new ConversationReadController(new ConversationRepository(prisma), noSla());
    await expect(ctrl.getConversation({ id: 'other-acct' }, md('acc-1', ['brand-a']))).rejects.toBeInstanceOf(
      RpcException,
    );
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
});

/**
 * Feature 014 added an event publisher to the write controller. These 012 specs are about access
 * control, so the publisher is a no-op stub here — the publishing behaviour has its own specs
 * (events/*.spec.ts, automation/no-cascade.spec.ts).
 */
function noEvents() {
  return {
    conversationCreated: jest.fn(async () => 0),
    statusChanged: jest.fn(async () => 0),
  } as unknown as DomainEventPublisher;
}

describe('Conversation writes (US1)', () => {
  it('CreateConversation still requires a brand — but never judges WHICH one', async () => {
    // ⚠️ Was: "refuses a brand outside the caller scope". No brand is outside anyone's scope
    // (ADR 0038 §1) — one support department serves them all. What survives is the requirement that
    // a conversation HAS a brand, because a record with no origin cannot be rendered or filtered.
    const { prisma, conversation } = fakePrisma();
    const ctrl = new ConversationWriteController(new ConversationRepository(prisma), noEvents());

    await expect(ctrl.createConversation({ brandId: '' }, md('acc-1'))).rejects.toBeInstanceOf(
      RpcException,
    );
    expect(conversation.create).not.toHaveBeenCalled();

    // The other half — that any named brand is accepted — is covered by the create-path tests in
    // `conversation.write.spec.ts`, which have the fake to run a creation through. Asserting it here
    // would mean building a second one to prove something already proven.
  });

  it('SetConversationStatus rejects an invalid status', async () => {
    const { prisma } = fakePrisma();
    const ctrl = new ConversationWriteController(new ConversationRepository(prisma), noEvents());
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
    const ctrl = new ConversationWriteController(new ConversationRepository(prisma), noEvents());
    const res = await ctrl.setConversationStatus(
      { conversationId: 'c1', status: 'CONVERSATION_STATUS_RESOLVED' },
      md('acc-1', ['brand-a']),
    );
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { status: 'resolved' } });
    expect(res.status).toBe('CONVERSATION_STATUS_RESOLVED');
  });
});
