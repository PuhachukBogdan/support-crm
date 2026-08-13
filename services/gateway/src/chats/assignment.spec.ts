import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type ClientGrpc } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { AssignmentController } from './assignment.controller';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';

/**
 * T015 (feature 013, US1/US3) — the assignment REST edge: correct permission declaration, actor
 * metadata from validated claims, and **gRPC errors translated** (the feature-012 Track-B lesson:
 * a raw `firstValueFrom` surfaced a cross-account read as a 500 with a stack trace).
 */
function makeCtrl(over: { assign?: jest.Mock; auto?: jest.Mock } = {}) {
  const assignConversation = over.assign ?? jest.fn().mockReturnValue(of({ id: 'c1' }));
  const autoAssignConversation =
    over.auto ?? jest.fn().mockReturnValue(of({ assigned: true, operatorId: 'op-a', reason: '' }));
  const client = {
    getService: () => ({ assignConversation, autoAssignConversation }),
  } as unknown as ClientGrpc;
  const ctrl = new AssignmentController(client);
  ctrl.onModuleInit();
  return { ctrl, assignConversation, autoAssignConversation };
}

const req = () =>
  ({
    claims: { accountId: 'acc-1', userId: 'u1', roles: ['support_agent'] },
    effective: { permissionKeys: ['crm.inbox.view', 'crm.conversation.assign'] },
  }) as never;

describe('AssignmentController (gateway proxy)', () => {
  it('proxies assign with the operator id and x-actor metadata (identity from claims, R1/R3)', async () => {
    const { ctrl, assignConversation } = makeCtrl();
    await ctrl.assign('c1', { operatorId: 'op-a' }, req());
    const [arg, md] = assignConversation.mock.calls[0] as [Record<string, unknown>, Metadata];
    expect(arg).toMatchObject({ conversationId: 'c1', operatorId: 'op-a' });
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
    expect(md.get('x-actor-permissions')[0]).toContain('crm.conversation.assign');
  });

  it('trims the operator id and sends "" for a blank one (the service unassigns on empty)', async () => {
    const { ctrl, assignConversation } = makeCtrl();
    await ctrl.assign('c1', { operatorId: '  op-b  ' }, req());
    expect((assignConversation.mock.calls[0][0] as { operatorId: string }).operatorId).toBe('op-b');

    await ctrl.assign('c1', { operatorId: '   ' }, req());
    expect((assignConversation.mock.calls[1][0] as { operatorId: string }).operatorId).toBe('');
  });

  it('unassign sends the same RPC with an empty operator id', async () => {
    const { ctrl, assignConversation } = makeCtrl();
    await ctrl.unassign('c1', req());
    expect(assignConversation.mock.calls[0][0]).toMatchObject({
      conversationId: 'c1',
      operatorId: '',
    });
  });

  it('normalises the auto-assign candidate set (numbers, trimmed ids, missing array)', async () => {
    const { ctrl, autoAssignConversation } = makeCtrl();
    await ctrl.autoAssign(
      'c1',
      { groupKey: ' team-a ', candidates: [{ operatorId: ' op-a ', capacity: 3, currentLoad: 1 }] },
      req(),
    );
    expect(autoAssignConversation.mock.calls[0][0]).toMatchObject({
      conversationId: 'c1',
      groupKey: 'team-a',
      candidates: [{ operatorId: 'op-a', capacity: 3, currentLoad: 1 }],
    });

    await ctrl.autoAssign('c1', {}, req());
    expect(autoAssignConversation.mock.calls[1][0]).toMatchObject({ groupKey: '', candidates: [] });
  });

  it('⭐ forwards `groupId` — the DESK path, which this route silently dropped until feature 031', () => {
    // The field has been on the wire since feature 024. Not forwarding it made everything the pool knows
    // (routability, per-channel cost, presence, the backlog, the unroutable event) unreachable from
    // outside the cluster, so no live run could have exercised any of it.
    const { ctrl, autoAssignConversation } = makeCtrl();
    return ctrl.autoAssign('c1', { groupId: ' desk-1 ' }, req()).then(() => {
      expect(autoAssignConversation.mock.calls[0][0]).toMatchObject({
        conversationId: 'c1',
        groupId: 'desk-1',
      });
    });
  });

  it('⚠️ an absent desk is `''`, never undefined — proto3 and "not asked for" must agree', () => {
    const { ctrl, autoAssignConversation } = makeCtrl();
    return ctrl.autoAssign('c1', {}, req()).then(() => {
      expect(autoAssignConversation.mock.calls[0][0]).toMatchObject({ groupId: '' });
    });
  });

  it('translates a downstream NOT_FOUND into 404, not 500 (feature-012 Track-B regression)', async () => {
    const rpcNotFound = Object.assign(new Error('5 NOT_FOUND: not found'), { code: 5 });
    const { ctrl } = makeCtrl({ assign: jest.fn().mockReturnValue(throwError(() => rpcNotFound)) });
    await expect(ctrl.assign('foreign', { operatorId: 'op-a' }, req())).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('declares crm.conversation.assign on every assignment route', () => {
    const reflector = new Reflector();
    for (const handler of [
      AssignmentController.prototype.assign,
      AssignmentController.prototype.unassign,
      AssignmentController.prototype.autoAssign,
    ]) {
      expect(reflector.get(REQUIRED_PERMISSION_KEY, handler)).toBe('crm.conversation.assign');
    }
  });

  it('makes no Users call for the operator (soft ref only — R8/R3)', () => {
    // The controller depends on exactly one gRPC client (chats); if a Users client were added the
    // constructor arity would change and this assertion would flag it.
    expect(AssignmentController.length).toBe(1);
  });
});
