import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type ClientGrpc } from '@nestjs/microservices';
import { of, throwError } from 'rxjs';
import { SlaController } from './sla.controller';
import { ConversationsController } from './conversations.controller';
import { REQUIRED_PERMISSION_KEY } from '../security/requires-permission.decorator';
import { toSlaOutcomeWire } from './wire';

/**
 * T036 (feature 014, US2) — the SLA REST edge. FAILS before the controller exists, PASSES after.
 *
 * Two design decisions are pinned here as behaviour rather than as comments:
 *  • the breached list is a **filter on the inbox**, so it needs only `crm.inbox.view` — the target
 *    itself is supervisory (`crm.sla.manage`). Reading which conversations were missed is part of
 *    doing the job; changing the promise the operation makes to players is not.
 *  • an unknown `slaOutcome` is a **400**. A mistyped filter that silently returns EVERY conversation
 *    is worse than an error, because it looks like it worked (the feature-012 lesson).
 */
function slaStubs(over: Record<string, jest.Mock> = {}) {
  const calls = {
    getFirstReplySlaPolicies:
      over.getFirstReplySlaPolicies ?? jest.fn().mockReturnValue(of({ policies: [] })),
    setFirstReplySlaPolicy:
      over.setFirstReplySlaPolicy ?? jest.fn().mockReturnValue(of({ id: 'p1' })),
  };
  const client = { getService: () => calls } as unknown as ClientGrpc;
  const c = new SlaController(client);
  c.onModuleInit();
  return { c, calls };
}

function convStubs() {
  const listConversations = jest
    .fn()
    .mockReturnValue(of({ conversations: [], nextPageToken: '' }));
  const client = {
    getService: () => ({ listConversations, getConversation: jest.fn(), getThread: jest.fn() }),
  } as unknown as ClientGrpc;
  const c = new ConversationsController(client);
  c.onModuleInit();
  return { c, listConversations };
}

const req = (perms: string[] = ['crm.sla.manage']) =>
  ({
    claims: { accountId: 'acc-1', userId: 'u1', roles: ['teamlead'] },
    effective: { permissionKeys: perms },
  }) as never;

describe('SLA REST edge — permissions', () => {
  const reflector = new Reflector();
  const perm = (h: unknown) => reflector.get(REQUIRED_PERMISSION_KEY, h as never);

  it('both policy routes require crm.sla.manage', () => {
    expect(perm(SlaController.prototype.get)).toBe('crm.sla.manage');
    expect(perm(SlaController.prototype.set)).toBe('crm.sla.manage');
  });

  it('the breached list rides on the inbox route, so crm.inbox.view is enough to READ it', () => {
    expect(perm(ConversationsController.prototype.list)).toBe('crm.inbox.view');
  });
});

describe('SLA REST edge — setting the target', () => {
  it('passes a valid target through, with omitted scopes meaning "any"', async () => {
    const { c, calls } = slaStubs();
    await c.set({ targetMinutes: 15 }, req());
    expect(calls.setFirstReplySlaPolicy.mock.calls[0][0]).toEqual({
      targetMinutes: 15,
      scopePriority: '',
      scopeBrandId: '',
    });
  });

  it('passes explicit scopes through, trimmed', async () => {
    const { c, calls } = slaStubs();
    await c.set({ targetMinutes: 5, scopePriority: ' high ', scopeBrandId: ' brand-a ' }, req());
    expect(calls.setFirstReplySlaPolicy.mock.calls[0][0]).toMatchObject({
      scopePriority: 'high',
      scopeBrandId: 'brand-a',
    });
  });

  it.each([0, -1, 'abc', undefined, null, Number.POSITIVE_INFINITY])(
    'rejects the target %p at the edge with no RPC',
    async (targetMinutes) => {
      const { c, calls } = slaStubs();
      await expect(
        c.set({ targetMinutes: targetMinutes as never }, req()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(calls.setFirstReplySlaPolicy).not.toHaveBeenCalled();
    },
  );

  // '*' is the "any scope" sentinel; accepting it as a real value would make the scope ambiguous.
  it("refuses '*' as a literal scope value", async () => {
    const { c, calls } = slaStubs();
    await expect(c.set({ targetMinutes: 5, scopePriority: '*' }, req())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(c.set({ targetMinutes: 5, scopeBrandId: '*' }, req())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(calls.setFirstReplySlaPolicy).not.toHaveBeenCalled();
  });

  it('translates a downstream PERMISSION_DENIED to 403', async () => {
    const { c } = slaStubs({
      getFirstReplySlaPolicies: jest
        .fn()
        .mockReturnValue(throwError(() => Object.assign(new Error('7'), { code: 7 }))),
    });
    await expect(c.get(req())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('propagates actor metadata', async () => {
    const { c, calls } = slaStubs();
    await c.get(req());
    const md = calls.getFirstReplySlaPolicies.mock.calls[0][1] as {
      get: (k: string) => string[];
    };
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
  });
});

describe('the slaOutcome filter on the conversation list (R10)', () => {
  it('maps the three documented values', () => {
    expect(toSlaOutcomeWire('running')).toBe('SLA_OUTCOME_RUNNING');
    expect(toSlaOutcomeWire('met')).toBe('SLA_OUTCOME_MET');
    expect(toSlaOutcomeWire('breached')).toBe('SLA_OUTCOME_BREACHED');
  });

  it('absent → UNSPECIFIED (no filter)', () => {
    expect(toSlaOutcomeWire()).toBe('SLA_OUTCOME_UNSPECIFIED');
    expect(toSlaOutcomeWire('')).toBe('SLA_OUTCOME_UNSPECIFIED');
  });

  it.each(['BREACHED', 'missed', 'late', 'breach', 'null'])(
    '*** rejects the unknown value %p rather than widening the query ***',
    (bad) => {
      expect(() => toSlaOutcomeWire(bad)).toThrow(BadRequestException);
    },
  );

  it('forwards the mapped filter on the list route', async () => {
    const { c, listConversations } = convStubs();
    await c.list({ slaOutcome: 'breached' }, req(['crm.inbox.view']));
    expect(listConversations.mock.calls[0][0]).toMatchObject({
      slaOutcome: 'SLA_OUTCOME_BREACHED',
    });
  });

  it('rejects a bad filter before the RPC', async () => {
    const { c, listConversations } = convStubs();
    await expect(c.list({ slaOutcome: 'nope' }, req(['crm.inbox.view']))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(listConversations).not.toHaveBeenCalled();
  });
});
