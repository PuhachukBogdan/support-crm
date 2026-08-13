import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type ClientGrpc } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import { AutomationsController } from './automations.controller';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';

/**
 * T021 (feature 014, US1) — the automations REST edge. FAILS before the controller exists.
 *
 * Three things are asserted, in order of how much they matter:
 *  1. `crm.automations.manage` is declared on every route — the surface that decides what the system
 *     does by itself must not be reachable by an ordinary agent.
 *  2. An invalid definition is refused **at the edge, with no RPC made**. A macro with a guessed
 *     action misfires once when clicked; a RULE with a guessed trigger misfires forever, on every
 *     future event, with nobody watching. So the edge must not forward one.
 *  3. Downstream gRPC statuses are translated (the feature-012/013 Track-B regressions: a raw error
 *     escaping as 500, and ALREADY_EXISTS surfacing as 500 instead of 409).
 */
function stubs(over: Record<string, jest.Mock> = {}) {
  const calls = {
    listAutomations:
      over.listAutomations ?? jest.fn().mockReturnValue(of({ automations: [], nextPageToken: '' })),
    listAutomationRuns:
      over.listAutomationRuns ?? jest.fn().mockReturnValue(of({ runs: [], nextPageToken: '' })),
    createAutomation: over.createAutomation ?? jest.fn().mockReturnValue(of({ id: 'a1' })),
    updateAutomation: over.updateAutomation ?? jest.fn().mockReturnValue(of({ id: 'a1' })),
    deleteAutomation: over.deleteAutomation ?? jest.fn().mockReturnValue(of({ ok: true })),
  };
  const client = { getService: () => calls } as unknown as ClientGrpc;
  const c = new AutomationsController(client);
  c.onModuleInit();
  return { c, calls };
}

const req = () =>
  ({
    claims: { accountId: 'acc-1', userId: 'u1', roles: ['teamlead'] },
    effective: { permissionKeys: ['crm.automations.manage'] },
  }) as never;

const DEF = {
  trigger: 'message_received',
  conditions: [{ field: 'assignee', op: 'absent', value: '' }],
  actions: [{ type: 'add_label', value: 'l1' }],
};

describe('Automations REST edge — permissions declared per route', () => {
  const reflector = new Reflector();
  const perm = (h: unknown) => reflector.get(REQUIRED_PERMISSION_KEY, h as never);

  it('every route requires crm.automations.manage', () => {
    for (const h of [
      AutomationsController.prototype.list,
      AutomationsController.prototype.runs,
      AutomationsController.prototype.create,
      AutomationsController.prototype.update,
      AutomationsController.prototype.remove,
    ]) {
      expect(perm(h)).toBe('crm.automations.manage');
    }
  });
});

describe('Automations REST edge — proxying', () => {
  it('propagates x-actor metadata from validated claims', async () => {
    const { c, calls } = stubs();
    await c.list(req());
    const md = calls.listAutomations.mock.calls[0][1] as Metadata;
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
    expect(md.get('x-actor-user-id')[0]).toBe('u1');
    expect(md.get('x-actor-permissions')[0]).toContain('crm.automations.manage');
  });

  it('maps a definition to wire enums', async () => {
    const { c, calls } = stubs();
    await c.create({ name: '  triage  ', definition: DEF }, req());
    expect(calls.createAutomation.mock.calls[0][0]).toMatchObject({
      name: 'triage',
      definition: {
        trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
        conditions: [{ field: 'CONDITION_FIELD_ASSIGNEE', op: 'CONDITION_OP_ABSENT', value: '' }],
        actions: [{ type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' }],
      },
      active: true,
    });
  });

  it('normalises a SET_STATUS / SET_PRIORITY action inside a rule', async () => {
    const { c, calls } = stubs();
    await c.create(
      {
        name: 'r',
        definition: {
          trigger: 'status_changed',
          conditions: [],
          actions: [
            { type: 'set_status', value: 'pending' },
            { type: 'set_priority', value: 'high' },
          ],
        },
      },
      req(),
    );
    expect(calls.createAutomation.mock.calls[0][0].definition.actions).toEqual([
      // Feature 032: a status KEY, passed through — the gateway holds no catalogue.
      { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'pending' },
      { type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'high' },
    ]);
  });

  it('never accepts an author from the body (that would be a privilege-escalation primitive)', async () => {
    const { c, calls } = stubs();
    await c.create(
      { name: 'r', definition: DEF, ...({ authorUserId: 'someone-powerful' } as object) },
      req(),
    );
    expect(JSON.stringify(calls.createAutomation.mock.calls[0][0])).not.toContain('someone-powerful');
  });

  it('sends explicit presence flags on update so ""/0/false cannot mean "clear this"', async () => {
    const { c, calls } = stubs();
    await c.update('a1', { active: false }, req());
    expect(calls.updateAutomation.mock.calls[0][0]).toMatchObject({
      id: 'a1',
      hasActive: true,
      active: false,
      hasName: false,
      hasDefinition: false,
      hasPosition: false,
    });
  });

  it('passes list/run filters and paging through', async () => {
    const { c, calls } = stubs();
    await c.runs(req(), 'a1', 'c1', 'tok', '25');
    expect(calls.listAutomationRuns.mock.calls[0][0]).toMatchObject({
      automationId: 'a1',
      conversationId: 'c1',
      pageToken: 'tok',
      pageSize: 25,
    });
  });
});

describe('Automations REST edge — fail-closed definition validation', () => {
  it.each([
    ['unknown trigger', { ...DEF, trigger: 'sla_missed' }],
    ['missing trigger', { ...DEF, trigger: undefined }],
    ['unknown condition field', { ...DEF, conditions: [{ field: 'tags', op: 'eq', value: 'x' }] }],
    ['unknown condition op', { ...DEF, conditions: [{ field: 'status', op: 'gt', value: 'x' }] }],
    ['unknown action', { ...DEF, actions: [{ type: 'send_message', value: 'hi' }] }],
    ['empty actions', { ...DEF, actions: [] }],
    ['bad priority', { ...DEF, actions: [{ type: 'set_priority', value: 'urgent' }] }],
    ['no definition at all', undefined],
  ])('*** rejects %s at the EDGE with no RPC made ***', async (_label, definition) => {
    const { c, calls } = stubs();
    await expect(
      c.create({ name: 'r', definition: definition as never }, req()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.createAutomation).not.toHaveBeenCalled();
  });

  it('validates a definition supplied on UPDATE too', async () => {
    const { c, calls } = stubs();
    await expect(
      c.update('a1', { definition: { ...DEF, trigger: 'nope' } }, req()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.updateAutomation).not.toHaveBeenCalled();
  });
});

describe('Automations REST edge — gRPC status translation', () => {
  const rpc = (code: number) => Object.assign(new Error(`${code}`), { code });

  it('NOT_FOUND (5) → 404', async () => {
    const { c } = stubs({ deleteAutomation: jest.fn().mockReturnValue(throwError(() => rpc(5))) });
    await expect(c.remove('nope', req())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ALREADY_EXISTS (6) → 409 for a duplicate rule name (not a 500)', async () => {
    const { c } = stubs({ createAutomation: jest.fn().mockReturnValue(throwError(() => rpc(6))) });
    await expect(c.create({ name: 'dup', definition: DEF }, req())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('PERMISSION_DENIED (7) → 403', async () => {
    const { c } = stubs({ listAutomations: jest.fn().mockReturnValue(throwError(() => rpc(7))) });
    await expect(c.list(req())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('INVALID_ARGUMENT (3) → 400', async () => {
    const { c } = stubs({ createAutomation: jest.fn().mockReturnValue(throwError(() => rpc(3))) });
    await expect(c.create({ name: 'r', definition: DEF }, req())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
