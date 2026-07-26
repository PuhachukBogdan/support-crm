import { Reflector } from '@nestjs/core';
import { type ClientGrpc } from '@nestjs/microservices';
import { of } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { MessagesController } from './messages.controller';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';

function makeCtrl() {
  const getThread = jest.fn().mockReturnValue(of({ messages: [], nextPageToken: '' }));
  const postMessage = jest.fn().mockReturnValue(of({ id: 'm1' }));
  const client = {
    getService: (name: string) =>
      name === 'ChatsReadService' ? { getThread } : { postMessage },
  } as unknown as ClientGrpc;
  const ctrl = new MessagesController(client);
  ctrl.onModuleInit();
  return { ctrl, getThread, postMessage };
}

const req = () =>
  ({
    claims: { accountId: 'acc-1', userId: 'op-1', roles: ['support_agent'], brands: ['brand-a'] },
    effective: { permissionKeys: ['crm.inbox.view', 'crm.conversation.reply'] },
  }) as never;

describe('MessagesController (gateway proxy, US2)', () => {
  it('requests the CUSTOMER projection when asked, with x-actor metadata', async () => {
    const { ctrl, getThread } = makeCtrl();
    await ctrl.thread('c1', { projection: 'customer' }, req());
    const [arg, md] = getThread.mock.calls[0] as [Record<string, unknown>, Metadata];
    expect(arg).toMatchObject({ conversationId: 'c1', projection: 'THREAD_PROJECTION_CUSTOMER' });
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
  });

  it('defaults to the STAFF projection', async () => {
    const { ctrl, getThread } = makeCtrl();
    await ctrl.thread('c1', {}, req());
    expect((getThread.mock.calls[0][0] as { projection: string }).projection).toBe(
      'THREAD_PROJECTION_STAFF',
    );
  });

  it('maps a note post to the PRIVATE_NOTE wire kind and forwards mentions', async () => {
    const { ctrl, postMessage } = makeCtrl();
    await ctrl.post('c1', { kind: 'note', body: 'psst', mentions: ['op-2'] }, req());
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      conversationId: 'c1',
      kind: 'MESSAGE_KIND_PRIVATE_NOTE',
      mentions: ['op-2'],
    });
  });

  it('maps a default post to a PUBLIC_REPLY', async () => {
    const { ctrl, postMessage } = makeCtrl();
    await ctrl.post('c1', { body: 'hello' }, req());
    expect((postMessage.mock.calls[0][0] as { kind: string }).kind).toBe('MESSAGE_KIND_PUBLIC_REPLY');
  });

  it('declares the RBAC permission each route requires', () => {
    const reflector = new Reflector();
    expect(reflector.get(REQUIRED_PERMISSION_KEY, MessagesController.prototype.thread)).toBe(
      'crm.inbox.view',
    );
    expect(reflector.get(REQUIRED_PERMISSION_KEY, MessagesController.prototype.post)).toBe(
      'crm.conversation.reply',
    );
  });
});
