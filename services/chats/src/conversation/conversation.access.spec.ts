import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import type { SlaRepository } from '../sla/sla.repository';
import { ConversationRepository } from './conversation.repository';
import { ConversationReadController } from './conversation.grpc.controller';
import type { DomainEventPublisher } from '../events/events.publisher';
import { ConversationWriteController } from './conversation.write.controller';
import { TransitionRecorder } from '../transition/transition.recorder';

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
  // Feature 023: `setStatus` now writes the change and its transition in ONE transaction, so the fake
  // client must offer `$transaction`. It runs the callback against this same fake — which is what
  // makes the assertions below still meaningful: they observe the real sequence (read before → update
  // → record), not a stubbed-out one.
  //
  // ⚠️ `$transaction` is defined as a METHOD on the object, not pulled into a variable. Feature 013
  // lost `this` exactly that way and every auto-assign 500ed; a fake that does not preserve the
  // binding would let that regression back in unnoticed.
  const conversationTransition = { create: over.transitionCreate ?? jest.fn() };
  const client = {
    conversation,
    conversationTransition,
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(client);
    },
  };
  const forAccount = jest.fn().mockReturnValue(client);
  return {
    prisma: { forAccount } as unknown as PrismaService,
    conversation,
    conversationTransition,
    forAccount,
  };
}

function md(accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
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
    const ctrl = new ConversationReadController(new ConversationRepository(prisma, new TransitionRecorder()), noSla());
    const res = await ctrl.getConversation({ id: 'c1' }, md('acc-1'));
    expect(forAccount).toHaveBeenCalledWith('acc-1');
    expect(res).toMatchObject({ id: 'c1', brandId: 'brand-a', status: 'CONVERSATION_STATUS_OPEN' });
  });

  it('is NOT_FOUND when the id is absent in this account (no cross-account read)', async () => {
    const { prisma } = fakePrisma({ findFirst: jest.fn().mockResolvedValue(null) });
    const ctrl = new ConversationReadController(new ConversationRepository(prisma, new TransitionRecorder()), noSla());
    await expect(ctrl.getConversation({ id: 'other-acct' }, md('acc-1'))).rejects.toBeInstanceOf(
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
    const ctrl = new ConversationWriteController(new ConversationRepository(prisma, new TransitionRecorder()), noEvents());

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
    const ctrl = new ConversationWriteController(new ConversationRepository(prisma, new TransitionRecorder()), noEvents());
    await expect(
      ctrl.setConversationStatus({ conversationId: 'c1', status: 'CONVERSATION_STATUS_UNSPECIFIED' }, md()),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('SetConversationStatus updates a permitted conversation and returns the new state', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(detailRow({ status: 'open' })) // brand/existence check
      // Feature 023 added a THIRD read: the `before` row, fetched inside the transaction so that
      // `from` is the value this update actually replaced rather than one read moments earlier.
      .mockResolvedValueOnce(detailRow({ status: 'open' })) // before-row, inside the transaction
      .mockResolvedValueOnce(detailRow({ status: 'resolved' })); // re-read after update
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { prisma, conversationTransition } = fakePrisma({ findFirst, updateMany });
    const ctrl = new ConversationWriteController(new ConversationRepository(prisma, new TransitionRecorder()), noEvents());
    const res = await ctrl.setConversationStatus(
      { conversationId: 'c1', status: 'CONVERSATION_STATUS_RESOLVED' },
      md('acc-1'),
    );
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { status: 'resolved' } });
    expect(res.status).toBe('CONVERSATION_STATUS_RESOLVED');

    // Feature 023: the transition rides the same transaction, names the human, and records BOTH
    // ends of the change — `from` is what makes the stream answer "what happened", not just "what is".
    expect(conversationTransition.create).toHaveBeenCalledTimes(1);
    const row = conversationTransition.create.mock.calls[0]![0].data;
    expect(row.type).toBe('conversation.status_changed');
    expect(row.payload_json).toEqual({ from: 'open', to: 'resolved' });
    expect(row.actor_kind).toBe('user');
    expect(row.actor_ref).toBe('u1');
    expect(row.subject_id).toBe('c1');
    // The snapshot is the dimensions as they were BEFORE the change (FR-003).
    expect(row.dims_json).toEqual({ brand: 'brand-a' });
  });
});
