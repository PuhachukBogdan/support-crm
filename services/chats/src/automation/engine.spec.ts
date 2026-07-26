import { AutomationEngine } from './engine';
import { AutomationsRepository } from './automations.repository';
import { AuthorityUnavailableError } from '../auth/auth.client';
import type { AuthorAuthorityClient } from '../auth/auth.client';
import type { LabelsRepository } from '../labels/labels.repository';
import type { DomainEvent } from '../events/events.types';
import { messageReceivedKey } from '../events/events.types';

/**
 * T017 (feature 014, US1) — the engine. FAILS before it exists, PASSES after.
 *
 * The load-bearing assertion here is SC-002: a rule whose author lacks ONE action's permission must
 * write **nothing at all**. Not "rolled back" — never attempted. So the tests do not merely check the
 * final state; they check that `applyWithRun` was never called, which is the only way to distinguish
 * "refused before writing" from "wrote and undid it". The second passes a state assertion while
 * remaining one failed rollback away from a half-changed conversation.
 */
const TRIGGER = 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED' as const;

const DEF = {
  trigger: TRIGGER,
  conditions: [{ field: 'CONDITION_FIELD_ASSIGNEE', op: 'CONDITION_OP_ABSENT', value: '' }],
  actions: [{ type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' }],
};
const DEF_WITH_ASSIGN = {
  trigger: TRIGGER,
  conditions: [],
  actions: [
    { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' },
    { type: 'MACRO_ACTION_TYPE_ASSIGN', value: 'op-1' },
  ],
};

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  name: 'rule',
  active: true,
  position: 0,
  revision: 3,
  author_user_id: 'author-1',
  definition: DEF,
  created_at: new Date('2026-07-01T00:00:00Z'),
  updated_at: new Date('2026-07-01T00:00:00Z'),
  ...over,
});

const event = (over: Partial<DomainEvent> = {}): DomainEvent => ({
  trigger: TRIGGER,
  accountId: 'acc-1',
  conversationId: 'c1',
  eventKey: messageReceivedKey('m1'),
  facts: {
    status: 'open',
    priority: null,
    brandId: 'b1',
    channel: 'web',
    hasAssignee: false,
    labelIds: [],
    messageText: 'please refund me',
  },
  ...over,
});

function build(opts: {
  rules?: unknown[];
  perms?: string[];
  authorityThrows?: Error;
  labelExists?: boolean;
  applyResult?: boolean;
} = {}) {
  const listActiveByTrigger = jest.fn().mockResolvedValue(opts.rules ?? [rule()]);
  const applyWithRun = jest.fn().mockResolvedValue(opts.applyResult ?? true);
  const recordRun = jest.fn().mockResolvedValue(true);
  const resolve = jest.fn(async () => {
    if (opts.authorityThrows) throw opts.authorityThrows;
    return { roleKey: 'teamlead', permissionKeys: opts.perms ?? ['crm.labels.manage'] };
  });
  const exists = jest.fn().mockResolvedValue(opts.labelExists ?? true);

  const engine = new AutomationEngine(
    { listActiveByTrigger, applyWithRun, recordRun } as unknown as AutomationsRepository,
    { exists } as unknown as LabelsRepository,
    { resolve } as unknown as AuthorAuthorityClient,
  );
  return { engine, listActiveByTrigger, applyWithRun, recordRun, resolve, exists };
}

describe('AutomationEngine — happy path', () => {
  it('applies a matching rule and records the run with the definition revision', async () => {
    const { engine, applyWithRun } = build();
    await expect(engine.handle(event())).resolves.toBe(1);
    expect(applyWithRun).toHaveBeenCalledWith(
      'acc-1',
      'c1',
      DEF.actions,
      expect.objectContaining({
        automationId: 'r1',
        automationRevision: 3,
        conversationId: 'c1',
        trigger: TRIGGER,
        eventKey: messageReceivedKey('m1'),
        outcome: 'applied',
      }),
    );
  });

  it('does nothing and makes no auth call when there are no rules for the trigger', async () => {
    const { engine, resolve, applyWithRun } = build({ rules: [] });
    await expect(engine.handle(event())).resolves.toBe(0);
    expect(resolve).not.toHaveBeenCalled();
    expect(applyWithRun).not.toHaveBeenCalled();
  });

  it('reports 0 applied when the batch was already recorded (at-most-once, R6)', async () => {
    const { engine } = build({ applyResult: false });
    await expect(engine.handle(event())).resolves.toBe(0);
  });
});

describe('AutomationEngine — conditions', () => {
  it('records not_matched and writes nothing when a condition fails', async () => {
    const { engine, applyWithRun, recordRun } = build();
    const assigned = event({ facts: { ...event().facts, hasAssignee: true } });
    await expect(engine.handle(assigned)).resolves.toBe(0);
    expect(applyWithRun).not.toHaveBeenCalled();
    expect(recordRun).toHaveBeenCalledWith('acc-1', expect.objectContaining({ outcome: 'not_matched' }));
  });

  it('does not resolve authority for a rule that did not match (no wasted hop)', async () => {
    const { engine, resolve } = build();
    await engine.handle(event({ facts: { ...event().facts, hasAssignee: true } }));
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('AutomationEngine — author authority (FR-023 / SC-002)', () => {
  it('*** refuses the WHOLE rule and writes NOTHING when the author lacks one action permission ***', async () => {
    const { engine, applyWithRun, recordRun } = build({
      rules: [rule({ definition: DEF_WITH_ASSIGN })],
      perms: ['crm.labels.manage'], // has labels, LACKS assign
    });
    await expect(engine.handle(event())).resolves.toBe(0);
    // The point: not a rollback — never attempted.
    expect(applyWithRun).not.toHaveBeenCalled();
    expect(recordRun).toHaveBeenCalledWith(
      'acc-1',
      expect.objectContaining({
        outcome: 'refused',
        reason: 'author lacks crm.conversation.assign',
      }),
    );
  });

  it('names the missing key so a silenced rule is diagnosable, not mysterious', async () => {
    const { engine, recordRun } = build({ perms: [] });
    await engine.handle(event());
    const reason = String(recordRun.mock.calls[0]![1].reason);
    expect(reason).toContain('crm.labels.manage');
  });

  it('refuses when auth is UNREACHABLE — never applies on assumed authority (FR-024)', async () => {
    const { engine, applyWithRun, recordRun } = build({
      authorityThrows: new AuthorityUnavailableError('rpc failed'),
    });
    await expect(engine.handle(event())).resolves.toBe(0);
    expect(applyWithRun).not.toHaveBeenCalled();
    expect(String(recordRun.mock.calls[0]![1].reason)).toContain('authority unavailable');
  });

  it('refuses on an unexpected authority error too (fail-closed, not fail-open)', async () => {
    const { engine, applyWithRun } = build({ authorityThrows: new Error('boom') });
    await expect(engine.handle(event())).resolves.toBe(0);
    expect(applyWithRun).not.toHaveBeenCalled();
  });

  it('resolves the author ONCE per pass for several rules by the same author (R5 memoisation)', async () => {
    const { engine, resolve } = build({
      rules: [rule({ id: 'r1' }), rule({ id: 'r2' }), rule({ id: 'r3' })],
    });
    await engine.handle(event());
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('resolves each distinct author separately', async () => {
    const { engine, resolve } = build({
      rules: [rule({ id: 'r1', author_user_id: 'a1' }), rule({ id: 'r2', author_user_id: 'a2' })],
    });
    await engine.handle(event());
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('caches an authority FAILURE per pass so a downed auth is not hammered once per rule', async () => {
    const { engine, resolve } = build({
      rules: [rule({ id: 'r1' }), rule({ id: 'r2' })],
      authorityThrows: new AuthorityUnavailableError('rpc failed'),
    });
    await engine.handle(event());
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});

describe('AutomationEngine — referenced entities', () => {
  it('refuses (writing nothing) when an ADD_LABEL label does not exist in the account', async () => {
    const { engine, applyWithRun, recordRun } = build({ labelExists: false });
    await expect(engine.handle(event())).resolves.toBe(0);
    expect(applyWithRun).not.toHaveBeenCalled();
    expect(String(recordRun.mock.calls[0]![1].reason)).toContain('label not found');
  });

  it('refuses an unreadable stored definition instead of guessing at it', async () => {
    const { engine, applyWithRun, recordRun } = build({
      rules: [rule({ definition: { trigger: 'NOPE', actions: [] } })],
    });
    // listActiveByTrigger is faked, so an unreadable blob still reaches evaluate() — which must
    // refuse rather than throw, exactly as a definition written by an older version would.
    await expect(engine.handle(event())).resolves.toBe(0);
    expect(applyWithRun).not.toHaveBeenCalled();
    expect(recordRun).toHaveBeenCalledWith('acc-1', expect.objectContaining({ outcome: 'refused' }));
  });
});

describe('AutomationEngine — ordering and independence', () => {
  it('evaluates every rule the repository returned, in the order given', async () => {
    const { engine, applyWithRun } = build({
      rules: [rule({ id: 'r1' }), rule({ id: 'r2' }), rule({ id: 'r3' })],
    });
    await expect(engine.handle(event())).resolves.toBe(3);
    expect(applyWithRun.mock.calls.map((c) => c[3].automationId)).toEqual(['r1', 'r2', 'r3']);
  });

  it('one refused rule does not stop the rest (independent evaluations)', async () => {
    const { engine, applyWithRun } = build({
      rules: [rule({ id: 'r1', definition: DEF_WITH_ASSIGN }), rule({ id: 'r2' })],
      perms: ['crm.labels.manage'],
    });
    await expect(engine.handle(event())).resolves.toBe(1);
    expect(applyWithRun.mock.calls.map((c) => c[3].automationId)).toEqual(['r2']);
  });

  it('a failing run-record write never breaks the triggering action', async () => {
    const { engine } = build();
    const eng = engine as unknown as {
      automations: { recordRun: jest.Mock };
    };
    eng.automations.recordRun = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(engine.handle(event({ facts: { ...event().facts, hasAssignee: true } }))).resolves.toBe(0);
  });
});
