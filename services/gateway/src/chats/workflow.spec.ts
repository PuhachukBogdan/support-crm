import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type ClientGrpc } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { LabelsController } from './labels.controller';
import { MacrosController } from './macros.controller';
import { CannedController } from './canned.controller';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';

/**
 * T023 (feature 013, US2) — the workflow REST edge: the right permission on every route, actor
 * metadata propagated, unknown macro actions rejected **at the edge** before any RPC, and downstream
 * gRPC statuses translated to HTTP (feature-012 Track-B regressions).
 */

function stubs(over: Record<string, jest.Mock> = {}) {
  const calls = {
    listLabels: over.listLabels ?? jest.fn().mockReturnValue(of({ labels: [] })),
    listConversationLabels:
      over.listConversationLabels ?? jest.fn().mockReturnValue(of({ labels: [] })),
    createLabel: over.createLabel ?? jest.fn().mockReturnValue(of({ id: 'l1' })),
    attachLabel: over.attachLabel ?? jest.fn().mockReturnValue(of({ ok: true })),
    detachLabel: over.detachLabel ?? jest.fn().mockReturnValue(of({ ok: true })),
    listMacros: over.listMacros ?? jest.fn().mockReturnValue(of({ macros: [] })),
    defineMacro: over.defineMacro ?? jest.fn().mockReturnValue(of({ id: 'm1' })),
    applyMacro: over.applyMacro ?? jest.fn().mockReturnValue(of({ id: 'c1' })),
    listCannedResponses: over.listCannedResponses ?? jest.fn().mockReturnValue(of({ canned: [] })),
    createCannedResponse:
      over.createCannedResponse ?? jest.fn().mockReturnValue(of({ id: 'cr1' })),
  };
  const client = { getService: () => calls } as unknown as ClientGrpc;
  const labels = new LabelsController(client);
  const macros = new MacrosController(client);
  const canned = new CannedController(client);
  labels.onModuleInit();
  macros.onModuleInit();
  canned.onModuleInit();
  return { labels, macros, canned, calls };
}

const req = () =>
  ({
    claims: { accountId: 'acc-1', userId: 'u1', roles: ['teamlead'] },
    effective: {
      permissionKeys: ['crm.labels.manage', 'crm.templates.manage', 'crm.macros.use'],
    },
  }) as never;

describe('Workflow REST edge — permissions declared per route (SC-005)', () => {
  const reflector = new Reflector();
  const perm = (h: unknown) => reflector.get(REQUIRED_PERMISSION_KEY, h as never);

  it('labels routes require crm.labels.manage', () => {
    for (const h of [
      LabelsController.prototype.list,
      LabelsController.prototype.create,
      LabelsController.prototype.listForConversation,
      LabelsController.prototype.attach,
      LabelsController.prototype.detach,
    ]) {
      expect(perm(h)).toBe('crm.labels.manage');
    }
  });

  it('macro AUTHORING requires crm.templates.manage but APPLYING requires crm.macros.use', () => {
    expect(perm(MacrosController.prototype.list)).toBe('crm.templates.manage');
    expect(perm(MacrosController.prototype.define)).toBe('crm.templates.manage');
    expect(perm(MacrosController.prototype.apply)).toBe('crm.macros.use');
  });

  it('canned-response routes require crm.templates.manage', () => {
    expect(perm(CannedController.prototype.list)).toBe('crm.templates.manage');
    expect(perm(CannedController.prototype.create)).toBe('crm.templates.manage');
  });
});

describe('Workflow REST edge — proxying', () => {
  it('propagates x-actor metadata (identity from validated claims)', async () => {
    const { labels, calls } = stubs();
    await labels.list(req());
    const md = calls.listLabels.mock.calls[0][1] as Metadata;
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
    expect(md.get('x-actor-permissions')[0]).toContain('crm.labels.manage');
  });

  it('passes the conversation + label ids through on attach/detach', async () => {
    const { labels, calls } = stubs();
    await labels.attach('c1', 'l1', req());
    await labels.detach('c1', 'l1', req());
    expect(calls.attachLabel.mock.calls[0][0]).toMatchObject({
      conversationId: 'c1',
      labelId: 'l1',
    });
    expect(calls.detachLabel.mock.calls[0][0]).toMatchObject({
      conversationId: 'c1',
      labelId: 'l1',
    });
  });

  it('trims label create input', async () => {
    const { labels, calls } = stubs();
    await labels.create({ name: '  urgent  ', color: ' #fff ' }, req());
    expect(calls.createLabel.mock.calls[0][0]).toMatchObject({ name: 'urgent', color: '#fff' });
  });

  it('maps macro actions to wire enums and normalises a SET_STATUS value', async () => {
    const { macros, calls } = stubs();
    await macros.define(
      {
        name: 'triage',
        actions: [
          { type: 'set_status', value: 'pending' },
          { type: 'add_label', value: 'l1' },
        ],
      },
      req(),
    );
    expect(calls.defineMacro.mock.calls[0][0]).toMatchObject({
      name: 'triage',
      actions: [
        { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'CONVERSATION_STATUS_PENDING' },
        { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' },
      ],
    });
  });

  it('*** rejects an unknown macro action at the EDGE — no RPC is made ***', async () => {
    const { macros, calls } = stubs();
    await expect(
      macros.define({ name: 'bad', actions: [{ type: 'send_message', value: 'hi' }] }, req()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.defineMacro).not.toHaveBeenCalled();
  });

  it('rejects an empty action list at the edge', async () => {
    const { macros, calls } = stubs();
    await expect(macros.define({ name: 'empty', actions: [] }, req())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(calls.defineMacro).not.toHaveBeenCalled();
  });

  it('passes both ids through on macro apply', async () => {
    const { macros, calls } = stubs();
    await macros.apply('c1', 'm1', req());
    expect(calls.applyMacro.mock.calls[0][0]).toMatchObject({
      conversationId: 'c1',
      macroId: 'm1',
    });
  });

  it('trims canned-response input', async () => {
    const { canned, calls } = stubs();
    await canned.create({ name: ' greeting ', body: ' hello ' }, req());
    expect(calls.createCannedResponse.mock.calls[0][0]).toMatchObject({
      name: 'greeting',
      body: 'hello',
    });
  });
});

describe('Workflow REST edge — gRPC status translation (feature-012 Track-B regression)', () => {
  const rpc = (code: number) => Object.assign(new Error(`${code}`), { code });

  it('a foreign-brand conversation (NOT_FOUND) becomes 404, not 500', async () => {
    const { labels } = stubs({ attachLabel: jest.fn().mockReturnValue(throwError(() => rpc(5))) });
    await expect(labels.attach('foreign', 'l1', req())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('a permission-blocked macro (PERMISSION_DENIED) becomes 403', async () => {
    const { macros } = stubs({ applyMacro: jest.fn().mockReturnValue(throwError(() => rpc(7))) });
    await expect(macros.apply('c1', 'm2', req())).rejects.toMatchObject({ status: 403 });
  });

  it('an invalid definition (INVALID_ARGUMENT) becomes 400', async () => {
    const { macros } = stubs({ defineMacro: jest.fn().mockReturnValue(throwError(() => rpc(3))) });
    await expect(
      macros.define({ name: 'x', actions: [{ type: 'add_label', value: 'l1' }] }, req()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
