import { Reflector } from '@nestjs/core';
import { type ClientGrpc } from '@nestjs/microservices';
import { of } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { ConversationsController } from './conversations.controller';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';

function makeCtrl() {
  const listConversations = jest.fn().mockReturnValue(of({ conversations: [], nextPageToken: '' }));
  const getConversation = jest.fn().mockReturnValue(of({ id: 'c1' }));
  const setConversationStatus = jest.fn().mockReturnValue(of({ id: 'c1' }));
  const setConversationSubject = jest.fn().mockReturnValue(of({ id: 'c1' }));
  const setConversationPriority = jest.fn().mockReturnValue(of({ id: 'c1' }));
  const client = {
    getService: (name: string) =>
      name === 'ChatsReadService'
        ? { listConversations, getConversation }
        : { setConversationStatus, setConversationSubject, setConversationPriority },
  } as unknown as ClientGrpc;
  const ctrl = new ConversationsController(client);
  ctrl.onModuleInit();
  return {
    ctrl,
    listConversations,
    getConversation,
    setConversationStatus,
    setConversationSubject,
    setConversationPriority,
  };
}

const req = () =>
  ({
    claims: { accountId: 'acc-1', userId: 'u1', roles: ['support_agent'] },
    effective: { permissionKeys: ['crm.inbox.view', 'crm.conversation.reply'] },
  }) as never;

describe('ConversationsController (gateway proxy, US1)', () => {
  it('proxies list with the status key/category and x-actor metadata (identity from claims, R1)', async () => {
    const { ctrl, listConversations } = makeCtrl();
    await ctrl.list({ status: 'vip_pending', statusCategory: 'pending' }, req());
    const [reqArg, md] = listConversations.mock.calls[0] as [Record<string, unknown>, Metadata];
    // ⭐ Feature 032: the KEY travels verbatim (the account owns that vocabulary) and the CATEGORY is
    // translated here (the six are closed and this tier legitimately knows them). The retired `status`
    // enum field is never sent at all — `chats` refuses it rather than mapping it.
    expect(reqArg.statusKey).toBe('vip_pending');
    expect(reqArg.statusCategory).toBe('CONVERSATION_STATUS_CATEGORY_PENDING');
    expect(reqArg.status).toBeUndefined();
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
    expect(md.get('x-actor-permissions')[0]).toContain('crm.inbox.view');
  });

  it('proxies get by id with metadata', async () => {
    const { ctrl, getConversation } = makeCtrl();
    await ctrl.get('c1', req());
    expect((getConversation.mock.calls[0][0] as { id: string }).id).toBe('c1');
  });

  it('sends the status KEY on PATCH status, and refuses an empty one', async () => {
    const { ctrl, setConversationStatus } = makeCtrl();
    await ctrl.setStatus('c1', { status: 'supervisor_review' }, req());
    const [arg] = setConversationStatus.mock.calls[0] as [
      { conversationId: string; statusKey: string },
    ];
    expect(arg).toMatchObject({ conversationId: 'c1', statusKey: 'supervisor_review' });
    // "Set the status to nothing" is malformed, and it is the one status check left at this tier.
    await expect(ctrl.setStatus('c1', { status: '' }, req())).rejects.toMatchObject({ status: 400 });
  });

  it('declares the RBAC permission each route requires (enforced by the global PermissionGuard)', () => {
    const reflector = new Reflector();
    expect(reflector.get(REQUIRED_PERMISSION_KEY, ConversationsController.prototype.list)).toBe(
      'crm.inbox.view',
    );
    expect(reflector.get(REQUIRED_PERMISSION_KEY, ConversationsController.prototype.get)).toBe(
      'crm.inbox.view',
    );
    expect(
      reflector.get(REQUIRED_PERMISSION_KEY, ConversationsController.prototype.setStatus),
    ).toBe('crm.conversation.reply');
    // Feature 023: the SAME key, deliberately. Naming a ticket is not a new kind of authority, and a
    // permission that gated one field would be a permission nobody remembers to assign.
    expect(
      reflector.get(REQUIRED_PERMISSION_KEY, ConversationsController.prototype.setSubject),
    ).toBe('crm.conversation.reply');
  });
});

/** T040 (feature 023, roadmap 4.18) — `PATCH /conversations/:id/subject`. */
describe('ConversationsController — the human title write', () => {
  it('forwards the normalised title and the actor metadata', async () => {
    const { ctrl, setConversationSubject } = makeCtrl();
    await ctrl.setSubject('c1', { subject: '  выплата\n  задерживается  ' }, req());
    const [arg, md] = setConversationSubject.mock.calls[0] as [
      { conversationId: string; subject: string },
      Metadata,
    ];
    expect(arg).toEqual({ conversationId: 'c1', subject: 'выплата задерживается' });
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
  });

  it('400s an over-long title at the EDGE, refusing rather than truncating', async () => {
    const { ctrl, setConversationSubject } = makeCtrl();
    await expect(ctrl.setSubject('c1', { subject: 'я'.repeat(121) }, req())).rejects.toMatchObject({
      status: 400,
    });
    // Nothing reached the owning service: the refusal is not a round trip.
    expect(setConversationSubject).not.toHaveBeenCalled();
  });

  it('400s a missing or blank title — an absent field never becomes a chosen default', async () => {
    const { ctrl } = makeCtrl();
    for (const subject of [undefined, '', '   ']) {
      await expect(ctrl.setSubject('c1', { subject }, req())).rejects.toMatchObject({ status: 400 });
    }
  });

  it('the 400 body carries the LIMIT and never the value the caller sent', async () => {
    const { ctrl } = makeCtrl();
    const err = await ctrl
      .setSubject('c1', { subject: 'секретное имя клиента '.repeat(20) }, req())
      .catch((e: unknown) => e as Error);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain('120');
    expect(message).not.toContain('секретное');
  });
});

/**
 * 2026-08-10 — `PATCH /conversations/:id/priority`, the write that did not exist.
 *
 * ⚠️ The load-bearing case is the EMPTY string. It is a legitimate value — "no priority", the state
 * every conversation is created in — and the obvious edge guard (`if (!priority) 400`) refuses exactly
 * that one value while passing every other, producing a field that can be set and never cleared.
 */
describe('ConversationsController — the priority write', () => {
  it('forwards a trimmed priority and the actor metadata', async () => {
    const { ctrl, setConversationPriority } = makeCtrl();
    await ctrl.setPriority('c1', { priority: '  high  ' }, req());
    const [arg, md] = setConversationPriority.mock.calls[0] as [
      { conversationId: string; priority: string },
      Metadata,
    ];
    expect(arg).toEqual({ conversationId: 'c1', priority: 'high' });
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
  });

  it('⭐ passes the EMPTY string through — clearing a priority is a real act', async () => {
    const { ctrl, setConversationPriority } = makeCtrl();
    await ctrl.setPriority('c1', { priority: '' }, req());
    expect(
      (setConversationPriority.mock.calls[0][0] as { priority: string }).priority,
    ).toBe('');
  });

  it('400s a MISSING field — an absent value never becomes a chosen default', async () => {
    const { ctrl, setConversationPriority } = makeCtrl();
    await expect(ctrl.setPriority('c1', {}, req())).rejects.toMatchObject({ status: 400 });
    expect(setConversationPriority).not.toHaveBeenCalled();
  });

  it('leaves the VOCABULARY to the owning service — the edge checks shape only', async () => {
    // Two tiers each holding their own idea of what a priority is, is how they drift apart. An
    // unknown word travels and is refused there, with one list of priorities in the product.
    const { ctrl, setConversationPriority } = makeCtrl();
    await ctrl.setPriority('c1', { priority: 'catastrophic' }, req());
    expect(
      (setConversationPriority.mock.calls[0][0] as { priority: string }).priority,
    ).toBe('catastrophic');
  });

  it('requires the conversation-write permission, not a key of its own', () => {
    const reflector = new Reflector();
    expect(
      reflector.get(REQUIRED_PERMISSION_KEY, ConversationsController.prototype.setPriority),
    ).toBe('crm.conversation.reply');
  });
});

/**
 * T013 (feature 029) — the two parameters the Inbox added, at the REST edge.
 *
 * ⚠️ The hazard being tested is specific to THIS controller: its `@Query()` is a fixed destructure,
 * so a parameter that is not named in it is **silently dropped**. Against `/players` an unknown
 * parameter is a 400; here it produces a confidently wrong answer — the caller believes the list is
 * narrowed and receives everything. That asymmetry is recorded in the front-end route registry and is
 * why these assertions check the value ARRIVES at the rpc, not merely that the call succeeded.
 */
describe('*** the Inbox filter and order reach the rpc (feature 029) ***', () => {
  it('passes channel through to the rpc', async () => {
    const { ctrl, listConversations } = makeCtrl();
    await ctrl.list({ channel: 'email' }, req());
    expect((listConversations.mock.calls[0][0] as { channel: string }).channel).toBe('email');
  });

  it('passes both orders through as their wire enums', async () => {
    for (const [rest, wire] of [
      ['updated_desc', 'CONVERSATION_ORDER_UPDATED_DESC'],
      ['updated_asc', 'CONVERSATION_ORDER_UPDATED_ASC'],
    ]) {
      const { ctrl, listConversations } = makeCtrl();
      await ctrl.list({ order: rest }, req());
      expect((listConversations.mock.calls[0][0] as { order: string }).order).toBe(wire);
    }
  });

  it('omitting either one sends the documented "no filter" / "default order" values', async () => {
    const { ctrl, listConversations } = makeCtrl();
    await ctrl.list({}, req());
    const arg = listConversations.mock.calls[0][0] as { channel: string; order: string };
    expect(arg.channel).toBe('');
    expect(arg.order).toBe('CONVERSATION_ORDER_UNSPECIFIED');
  });

  it('⭐ 400s an unknown order and never falls back to the default', async () => {
    for (const order of ['recommended', 'urgency', 'created_desc', 'nonsense']) {
      const { ctrl, listConversations } = makeCtrl();
      await expect(ctrl.list({ order }, req())).rejects.toMatchObject({ status: 400 });
      expect(listConversations).not.toHaveBeenCalled(); // refused BEFORE the rpc, not after
    }
  });

  it('⛔ "recommended" is not an accepted order — nothing computes urgency (roadmap 4.20)', async () => {
    const { ctrl } = makeCtrl();
    const err = await ctrl.list({ order: 'recommended' }, req()).catch((e: unknown) => e as Error);
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toContain('updated_desc');
    expect(message).toContain('updated_asc');
    expect(message).not.toContain('recommended: ok');
  });

  it('400s a malformed channel (blank-ish or absurd), but NOT an unknown-but-plausible one', async () => {
    // ⚠️ Deliberate asymmetry with `status`: a channel is DATA, never a branch (roadmap 9.6a), so the
    // edge cannot hold a closed list without making every Phase-6 channel unfilterable on arrival.
    // An unrecognised channel narrows to zero rows — visible — rather than widening the result set,
    // which is the failure the fail-closed rule actually exists to prevent.
    for (const channel of ['   ', 'has space', 'x'.repeat(65), 'drop;table']) {
      const { ctrl } = makeCtrl();
      await expect(ctrl.list({ channel }, req())).rejects.toMatchObject({ status: 400 });
    }
    const { ctrl, listConversations } = makeCtrl();
    await ctrl.list({ channel: 'telegram' }, req()); // not in the data yet — still a legitimate ask
    expect((listConversations.mock.calls[0][0] as { channel: string }).channel).toBe('telegram');
  });
});
