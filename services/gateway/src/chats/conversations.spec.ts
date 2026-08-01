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
  const client = {
    getService: (name: string) =>
      name === 'ChatsReadService'
        ? { listConversations, getConversation }
        : { setConversationStatus, setConversationSubject },
  } as unknown as ClientGrpc;
  const ctrl = new ConversationsController(client);
  ctrl.onModuleInit();
  return { ctrl, listConversations, getConversation, setConversationStatus, setConversationSubject };
}

const req = () =>
  ({
    claims: { accountId: 'acc-1', userId: 'u1', roles: ['support_agent'] },
    effective: { permissionKeys: ['crm.inbox.view', 'crm.conversation.reply'] },
  }) as never;

describe('ConversationsController (gateway proxy, US1)', () => {
  it('proxies list with mapped status and x-actor metadata (identity from claims, R1)', async () => {
    const { ctrl, listConversations } = makeCtrl();
    await ctrl.list({ status: 'open' }, req());
    const [reqArg, md] = listConversations.mock.calls[0] as [Record<string, unknown>, Metadata];
    expect(reqArg.status).toBe('CONVERSATION_STATUS_OPEN');
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
    expect(md.get('x-actor-permissions')[0]).toContain('crm.inbox.view');
  });

  it('proxies get by id with metadata', async () => {
    const { ctrl, getConversation } = makeCtrl();
    await ctrl.get('c1', req());
    expect((getConversation.mock.calls[0][0] as { id: string }).id).toBe('c1');
  });

  it('maps the status body to the wire enum on PATCH status', async () => {
    const { ctrl, setConversationStatus } = makeCtrl();
    await ctrl.setStatus('c1', { status: 'resolved' }, req());
    const [arg] = setConversationStatus.mock.calls[0] as [{ conversationId: string; status: string }];
    expect(arg).toMatchObject({ conversationId: 'c1', status: 'CONVERSATION_STATUS_RESOLVED' });
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
