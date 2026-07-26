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
  const client = {
    getService: (name: string) =>
      name === 'ChatsReadService'
        ? { listConversations, getConversation }
        : { setConversationStatus },
  } as unknown as ClientGrpc;
  const ctrl = new ConversationsController(client);
  ctrl.onModuleInit();
  return { ctrl, listConversations, getConversation, setConversationStatus };
}

const req = () =>
  ({
    claims: { accountId: 'acc-1', userId: 'u1', roles: ['support_agent'], brands: ['brand-a'] },
    effective: { permissionKeys: ['crm.inbox.view', 'crm.conversation.reply'] },
  }) as never;

describe('ConversationsController (gateway proxy, US1)', () => {
  it('proxies list with mapped status and x-actor metadata (identity + brands from claims, R1/R3)', async () => {
    const { ctrl, listConversations } = makeCtrl();
    await ctrl.list({ status: 'open' }, req());
    const [reqArg, md] = listConversations.mock.calls[0] as [Record<string, unknown>, Metadata];
    expect(reqArg.status).toBe('CONVERSATION_STATUS_OPEN');
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
    expect(md.get('x-actor-permissions')[0]).toContain('crm.inbox.view');
    expect(md.get('x-actor-brands')[0]).toBe('brand-a');
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
  });
});
