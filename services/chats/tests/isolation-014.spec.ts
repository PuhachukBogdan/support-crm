import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../src/prisma.service';
import { AutomationsRepository } from '../src/automation/automations.repository';
import { AuditRepository } from '../src/audit/audit.repository';
import { AutomationsController } from '../src/automation/automations.grpc.controller';
import { AutomationEngine } from '../src/automation/engine';
import { LabelsRepository } from '../src/labels/labels.repository';
import type { AuthorAuthorityClient } from '../src/auth/auth.client';
import { messageReceivedKey } from '../src/events/events.types';
import { TransitionRecorder } from '../src/transition/transition.recorder';
import { fakeStatusRepository } from '../src/status/status.fixture';

/**
 * T020 / T034 (feature 014) — cross-account isolation sweep for automations + SLA (Principle I /
 * SC-003). One store holds rows in TWO accounts, colliding on the ids a caller might guess: the same
 * automation id, the same conversation id, the same policy scope exist in both.
 *
 * The interesting case this feature introduces, and the reason this file exists separately from
 * isolation-013: **the engine writes with no human caller.** Every previous write in the product was
 * reached through a gateway request carrying an account. A timer-driven or event-driven write has no
 * request at all, so "the caller's account was checked" is not an available argument — the only thing
 * standing between the engine and another tenant's rows is that it goes through `forAccount` like
 * everything else. That is asserted here directly.
 */
interface Row {
  id: string;
  account_id: string;
  [k: string]: unknown;
}

const automations: Row[] = [
  {
    id: 'a-shared',
    account_id: 'acc-1',
    name: 'ours',
    active: true,
    position: 0,
    revision: 1,
    author_user_id: 'u1',
    definition: {
      trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
      conditions: [],
      actions: [{ type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l-1' }],
    },
    created_at: new Date('2026-07-27T10:00:00.000Z'),
    updated_at: new Date('2026-07-27T10:00:00.000Z'),
  },
  // Same automation id in the other account — the trap.
  {
    id: 'a-shared',
    account_id: 'acc-2',
    name: 'theirs',
    active: true,
    position: 0,
    revision: 9,
    author_user_id: 'u-foreign',
    definition: {
      trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
      conditions: [],
      actions: [{ type: 'MACRO_ACTION_TYPE_ASSIGN', value: 'op-foreign' }],
    },
    created_at: new Date('2026-07-27T10:00:00.000Z'),
    updated_at: new Date('2026-07-27T10:00:00.000Z'),
  },
  {
    id: 'a-only-2',
    account_id: 'acc-2',
    name: 'foreign only',
    active: true,
    position: 0,
    revision: 1,
    author_user_id: 'u-foreign',
    definition: {
      trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
      conditions: [],
      actions: [{ type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l-foreign' }],
    },
    created_at: new Date('2026-07-27T10:00:00.000Z'),
    updated_at: new Date('2026-07-27T10:00:00.000Z'),
  },
];

const runs: Row[] = [
  {
    id: 'run-1',
    account_id: 'acc-1',
    automation_id: 'a-shared',
    automation_revision: 1,
    conversation_id: 'c-shared',
    trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
    outcome: 'applied',
    reason: null,
    created_at: new Date('2026-07-27T10:00:00.000Z'),
  },
  {
    id: 'run-2',
    account_id: 'acc-2',
    automation_id: 'a-shared',
    automation_revision: 9,
    conversation_id: 'c-shared',
    trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
    outcome: 'applied',
    reason: 'foreign',
    created_at: new Date('2026-07-27T10:00:00.000Z'),
  },
];

const labels: Row[] = [
  { id: 'l-1', account_id: 'acc-1', name: 'ours' },
  { id: 'l-foreign', account_id: 'acc-2', name: 'theirs' },
];

/** Every write, with the account whose scoped client performed it. */
const writes: { table: string; account: string; data: unknown }[] = [];

function scopedFor(acc: string) {
  const own = (rows: Row[]) => rows.filter((r) => r.account_id === acc);
  const findFirstIn = (rows: Row[], where: Record<string, unknown> = {}) =>
    Promise.resolve(
      own(rows).find((r) =>
        Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
      ) ?? null,
    );

  const scoped = {
    automation: {
      findFirst: (a: { where: Record<string, unknown> }) => findFirstIn(automations, a.where),
      findMany: () => Promise.resolve(own(automations)),
      create: (a: { data: Row }) => {
        writes.push({ table: 'automation', account: acc, data: a.data });
        return Promise.resolve({ ...a.data, id: 'new', created_at: new Date(), updated_at: new Date() });
      },
      updateMany: (a: { where: Record<string, unknown>; data: unknown }) => {
        const target = own(automations).find((r) => r.id === a.where.id);
        if (!target) return Promise.resolve({ count: 0 });
        writes.push({ table: 'automation:update', account: acc, data: a.data });
        return Promise.resolve({ count: 1 });
      },
      deleteMany: (a: { where: Record<string, unknown> }) => {
        const target = own(automations).find((r) => r.id === a.where.id);
        if (!target) return Promise.resolve({ count: 0 });
        writes.push({ table: 'automation:delete', account: acc, data: a.where });
        return Promise.resolve({ count: 1 });
      },
    },
    auditEntry: {
      create: (a: { data: Row }) => {
        writes.push({ table: 'auditEntry', account: acc, data: a.data });
        return Promise.resolve({ ...a.data, id: 'new' });
      },
    },
    automationRun: {
      findMany: () => Promise.resolve(own(runs)),
      create: (a: { data: Row }) => {
        writes.push({ table: 'automationRun', account: acc, data: a.data });
        return Promise.resolve({ ...a.data, id: 'new' });
      },
    },
    label: {
      findFirst: (a: { where: Record<string, unknown> }) => findFirstIn(labels, a.where),
      findMany: () => Promise.resolve(own(labels)),
    },
    conversationLabel: {
      findMany: () => Promise.resolve([]),
      upsert: (a: unknown) => {
        writes.push({ table: 'conversationLabel', account: acc, data: a });
        return Promise.resolve({});
      },
    },
    conversation: {
      updateMany: (a: unknown) => {
        writes.push({ table: 'conversation', account: acc, data: a });
        return Promise.resolve({ count: 1 });
      },
      // Feature 023: the before-row, read before the batch is assembled.
      findFirst: () =>
        Promise.resolve({
          id: 'c1',
          status: 'open',
          brand_id: 'brand-a',
          channel: null,
          assignee_operator_id: null,
        }),
    },
    // Feature 023: recorded through the SCOPED client like every other write, so the assertion that
    // the engine never touches the base client covers transitions too.
    conversationTransition: {
      create: (a: unknown) => {
        writes.push({ table: 'conversationTransition', account: acc, data: a });
        return Promise.resolve({});
      },
    },
  } as Record<string, unknown>;
  scoped.$transaction = (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(scoped) : Promise.resolve([]);
  return scoped;
}

const forAccount = jest.fn((acc: string) => scopedFor(acc));
const prisma = { forAccount } as unknown as PrismaService;

function md(accountId: string, perms: string[] = ['crm.automations.manage']): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
  m.set('x-actor-permissions', perms.join(','));
  return m;
}

// Feature 015: the controller also writes an audit entry inside the delete's transaction.
const controller = () =>
  new AutomationsController(
    new AutomationsRepository(prisma, new TransitionRecorder()),
    new AuditRepository(prisma),
    fakeStatusRepository(),
  );

beforeEach(() => {
  writes.length = 0;
  forAccount.mockClear();
});

describe('automation authoring is account-scoped', () => {
  it('lists only this account’s rules (the same id in acc-2 stays invisible)', async () => {
    const res = await controller().listAutomations({}, md('acc-1'));
    expect(res.automations.map((a) => a.name)).toEqual(['ours']);
    expect(JSON.stringify(res)).not.toContain('theirs');
    expect(JSON.stringify(res)).not.toContain('foreign');
    expect(forAccount).toHaveBeenCalledWith('acc-1');
  });

  it('cannot read a foreign rule even by its exact id', async () => {
    // 'a-only-2' exists only in acc-2 — from acc-1 it must be NOT_FOUND, not a redacted row.
    await expect(
      controller().updateAutomation({ id: 'a-only-2', hasActive: true, active: false }, md('acc-1')),
    ).rejects.toBeInstanceOf(RpcException);
    expect(writes).toHaveLength(0);
  });

  it('cannot delete a foreign rule', async () => {
    await expect(
      controller().deleteAutomation({ id: 'a-only-2' }, md('acc-1')),
    ).rejects.toBeInstanceOf(RpcException);
    expect(writes).toHaveLength(0);
  });

  it('updating a SHARED id touches only this account’s row', async () => {
    await controller().updateAutomation({ id: 'a-shared', hasActive: true, active: false }, md('acc-1'));
    expect(writes.every((w) => w.account === 'acc-1')).toBe(true);
  });

  it('creating a rule stamps the caller’s account, never one from the body', async () => {
    await controller().createAutomation(
      {
        name: 'new rule',
        definition: {
          trigger: 'AUTOMATION_TRIGGER_STATUS_CHANGED',
          conditions: [],
          actions: [{ type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'high' }],
        },
      },
      md('acc-1'),
    );
    const data = writes[0]!.data as Record<string, unknown>;
    expect(data.account_id).toBe('acc-1');
    // …and the AUTHOR comes from validated metadata, not the request (else rule creation would be a
    // privilege-escalation primitive: name any author, borrow their permissions).
    expect(data.author_user_id).toBe('u1');
  });

  it('run records are account-scoped too', async () => {
    const res = await controller().listAutomationRuns({}, md('acc-1'));
    expect(res.runs.map((r) => r.id)).toEqual(['run-1']);
    expect(JSON.stringify(res)).not.toContain('foreign');
  });
});

describe('the ENGINE’s caller-less writes stay inside the account (the new case in 014)', () => {
  const engine = (accountId: string) =>
    new AutomationEngine(
      new AutomationsRepository(prisma, new TransitionRecorder()),
      new LabelsRepository(prisma),
      {
        resolve: jest.fn(async () => ({
          roleKey: 'teamlead',
          permissionKeys: ['crm.labels.manage', 'crm.conversation.assign', 'crm.conversation.reply'],
        })),
      } as unknown as AuthorAuthorityClient,
      // Feature 032: the engine re-validates against the account's statuses. The fixture is the seeded
      // nine, so this test stays about the ACCOUNT boundary and not about the vocabulary.
      fakeStatusRepository(),
    ).handle({
      trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
      accountId,
      conversationId: 'c-shared',
      eventKey: messageReceivedKey('m1'),
      facts: {
        status: 'open',
        priority: null,
        brandId: 'brand-a',
        channel: 'web',
        hasAssignee: false,
        labelIds: [],
        // Feature 024: unscoped work — no desk took it. Required, so the compiler names every fixture.
        routedGroupId: null,
      },
    });

  it('an event in acc-1 runs acc-1 rules only — the foreign rule never fires', async () => {
    await engine('acc-1');
    expect(forAccount).not.toHaveBeenCalledWith('acc-2');
    expect(writes.every((w) => w.account === 'acc-1')).toBe(true);
    // The acc-2 rule would have ASSIGNED op-foreign; nothing in the writes may mention it.
    expect(JSON.stringify(writes)).not.toContain('op-foreign');
  });

  it('an event in acc-2 runs acc-2 rules only', async () => {
    await engine('acc-2');
    expect(writes.every((w) => w.account === 'acc-2')).toBe(true);
    expect(forAccount).not.toHaveBeenCalledWith('acc-1');
  });

  it('every engine write went through a SCOPED client (never the base client)', async () => {
    await engine('acc-1');
    // Any write at all implies forAccount was consulted first; a write without it is the failure
    // mode this asserts against.
    expect(writes.length).toBeGreaterThan(0);
    expect(forAccount).toHaveBeenCalledWith('acc-1');
    for (const w of writes) expect(w.account).toBe('acc-1');
  });

  it('a rule referencing a FOREIGN label is refused, not applied across the boundary', async () => {
    // acc-1's rule adds l-1 (its own). Point the acc-1 rule at the foreign label instead.
    const original = automations[0]!.definition;
    automations[0]!.definition = {
      trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
      conditions: [],
      actions: [{ type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l-foreign' }],
    };
    try {
      await engine('acc-1');
      const labelWrites = writes.filter((w) => w.table === 'conversationLabel');
      expect(labelWrites).toHaveLength(0);
      const run = writes.find((w) => w.table === 'automationRun')!.data as Record<string, unknown>;
      expect(run.outcome).toBe('refused');
    } finally {
      automations[0]!.definition = original;
    }
  });
});

/**
 * T034 (feature 014, US2) — the SLA half of the isolation sweep.
 *
 * The sweep is the only cross-account path in the product, so it gets the sharpest test: two accounts
 * both have an overdue clock, and the sweep must mark each one **under its own account scope**. A single
 * mis-scoped write here would mean one tenant's timer mutating another tenant's conversation — with no
 * request, no user and no log line to notice it by.
 */
describe('SLA policy + state are account-scoped', () => {
  const policies: Row[] = [
    { id: 'p-1', account_id: 'acc-1', target_minutes: 10, scope_priority: '*', scope_brand_id: '*' },
    { id: 'p-2', account_id: 'acc-2', target_minutes: 1, scope_priority: '*', scope_brand_id: '*' },
  ];
  const states: Row[] = [
    {
      id: 's-1',
      account_id: 'acc-1',
      conversation_id: 'c-shared',
      outcome: 'running',
      started_at: new Date('2026-07-27T10:00:00.000Z'),
      deadline_at: new Date('2026-07-27T10:10:00.000Z'),
      target_minutes: 10,
      first_reply_at: null,
      first_reply_seconds: null,
      breach_announced_at: null,
    },
    {
      // SAME conversation id, other account — the trap.
      id: 's-2',
      account_id: 'acc-2',
      conversation_id: 'c-shared',
      outcome: 'running',
      started_at: new Date('2026-07-27T10:00:00.000Z'),
      deadline_at: new Date('2026-07-27T10:01:00.000Z'),
      target_minutes: 1,
      first_reply_at: null,
      first_reply_seconds: null,
      breach_announced_at: null,
    },
  ];

  const slaWrites: { table: string; account: string; where: unknown; data: unknown }[] = [];

  function slaScoped(acc: string) {
    const own = (rows: Row[]) => rows.filter((r) => r.account_id === acc);
    return {
      firstReplySlaPolicy: {
        findMany: () => Promise.resolve(own(policies)),
        findFirst: () => Promise.resolve(own(policies)[0] ?? null),
        create: (a: { data: Row }) => {
          slaWrites.push({ table: 'policy', account: acc, where: null, data: a.data });
          return Promise.resolve({ ...a.data, id: 'new' });
        },
        updateMany: (a: { where: unknown; data: unknown }) => {
          slaWrites.push({ table: 'policy:update', account: acc, where: a.where, data: a.data });
          return Promise.resolve({ count: 1 });
        },
      },
      conversationSlaState: {
        findFirst: (a: { where: Record<string, unknown> }) =>
          Promise.resolve(
            own(states).find((r) => r.conversation_id === a.where.conversation_id) ?? null,
          ),
        findMany: () => Promise.resolve(own(states)),
        create: (a: { data: Row }) => {
          slaWrites.push({ table: 'state', account: acc, where: null, data: a.data });
          return Promise.resolve(a.data);
        },
        updateMany: (a: { where: unknown; data: unknown }) => {
          const target = own(states)[0];
          if (!target) return Promise.resolve({ count: 0 });
          slaWrites.push({ table: 'state:update', account: acc, where: a.where, data: a.data });
          return Promise.resolve({ count: 1 });
        },
      },
    } as Record<string, unknown>;
  }

  const slaForAccount = jest.fn((acc: string) => slaScoped(acc));
  // The base client is what the SWEEP uses (and only the sweep).
  const basePrisma = {
    forAccount: slaForAccount,
    conversationSlaState: {
      findMany: jest.fn(async () =>
        states.map((s) => ({ account_id: s.account_id, conversation_id: s.conversation_id })),
      ),
    },
  } as unknown as PrismaService;

  beforeEach(() => {
    slaWrites.length = 0;
    slaForAccount.mockClear();
  });

  it('a policy read sees only this account’s targets', async () => {
    const { SlaRepository } = await import('../src/sla/sla.repository');
    const rows = await new SlaRepository(basePrisma).listPolicies('acc-1');
    expect(rows.map((r) => r.id)).toEqual(['p-1']);
    expect(slaForAccount).toHaveBeenCalledWith('acc-1');
  });

  it('a state read for a SHARED conversation id returns this account’s row', async () => {
    const { SlaRepository } = await import('../src/sla/sla.repository');
    const repo = new SlaRepository(basePrisma);
    expect((await repo.getState('acc-1', 'c-shared'))!.id).toBe('s-1');
    expect((await repo.getState('acc-2', 'c-shared'))!.id).toBe('s-2');
  });

  it('*** the SWEEP marks each due conversation under its OWN account scope ***', async () => {
    const { SlaRepository } = await import('../src/sla/sla.repository');
    const { SlaSweepRepository } = await import('../src/sla/sla-sweep.repository');
    const { SlaMaintenanceController } = await import('../src/sla/sla.grpc.controller');

    const publisher = { firstReplyBreached: jest.fn(async () => 0) };
    const ctrl = new SlaMaintenanceController(
      new SlaRepository(basePrisma),
      new SlaSweepRepository(basePrisma),
      publisher as never,
    );
    const systemMd = new Metadata();
    systemMd.set('x-actor-kind', 'system');

    const res = await ctrl.sweepFirstReplySla({ limit: 100 }, systemMd);

    expect(res.checked).toBe(2);
    // Both accounts were swept — each through its own scoped client, never one via the other.
    expect(slaForAccount.mock.calls.map((c) => c[0])).toEqual(['acc-1', 'acc-2']);
    expect(slaWrites.map((w) => w.account)).toEqual(['acc-1', 'acc-2']);
    // …and each write is additionally narrowed by the conversation id + running guard.
    for (const w of slaWrites) {
      expect(w.where).toMatchObject({ conversation_id: 'c-shared', outcome: 'running' });
    }
    // The breach event is published per account, never cross-wired.
    expect(publisher.firstReplyBreached.mock.calls).toEqual([
      ['acc-1', 'c-shared'],
      ['acc-2', 'c-shared'],
    ]);
  });

  it('the breached-list read is account-scoped', async () => {
    const { SlaRepository } = await import('../src/sla/sla.repository');
    const ids = await new SlaRepository(basePrisma).conversationIdsByOutcome('acc-1', 'running');
    expect(ids).toEqual(['c-shared']);
    expect(slaForAccount).toHaveBeenCalledWith('acc-1');
  });
});
