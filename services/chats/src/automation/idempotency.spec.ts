import { AutomationsRepository } from './automations.repository';
import type { PrismaService } from '../prisma.service';
import { messageReceivedKey } from '../events/events.types';
import type { RunRecord } from './automations.repository';
import { TransitionRecorder } from '../transition/transition.recorder';

/**
 * T019 (feature 014, US1) — **SC-005: replaying the same event applies the effect once.**
 * FAILS before the repository exists, PASSES after.
 *
 * The mechanism under test is that the guarantee is a **database constraint**, not application
 * bookkeeping (research R6): the run record shares the transaction with the actions, so a duplicate
 * `(automation_id, conversation_id, event_key)` aborts the whole batch and nothing is applied twice.
 *
 * Why not an application check: "have I already handled this?" read followed by a write is a race —
 * two ticks of the sweep, or a retry overlapping the original, can both pass the check. A unique index
 * cannot. So the assertions below are about the *shape* of the write (one transaction containing the
 * run record) and about a P2002 being translated into a benign no-op rather than an error.
 */
const RUN: RunRecord = {
  automationId: 'r1',
  automationRevision: 2,
  conversationId: 'c1',
  trigger: 'AUTOMATION_TRIGGER_MESSAGE_RECEIVED',
  eventKey: messageReceivedKey('m1'),
  outcome: 'applied',
};

const P2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

function fakePrisma(over: { transaction?: jest.Mock; runCreate?: jest.Mock } = {}) {
  const runCreate = over.runCreate ?? jest.fn((args: unknown) => ({ __create: args }));
  const $transaction = over.transaction ?? jest.fn(async () => []);
  const scoped = {
    conversation: {
      updateMany: jest.fn((a: unknown) => ({ __update: a })),
      // Feature 023: awaited before the batch is assembled (see macros.spec.ts).
      findFirst: jest.fn().mockResolvedValue({
        id: 'c1',
        status: 'open',
        brand_id: 'brand-a',
        channel: null,
        assignee_operator_id: null,
      }),
    },
    conversationTransition: { create: jest.fn((a: unknown) => ({ __transition: a })) },
    conversationLabel: { upsert: jest.fn((a: unknown) => ({ __upsert: a })) },
    automationRun: { create: runCreate },
    $transaction,
  };
  const forAccount = jest.fn(() => scoped);
  return { prisma: { forAccount } as unknown as PrismaService, scoped, forAccount, $transaction, runCreate };
}

describe('applyWithRun — atomicity + at-most-once', () => {
  it('puts the actions AND the run record in ONE transaction', async () => {
    const { prisma, $transaction } = fakePrisma();
    const repo = new AutomationsRepository(prisma, new TransitionRecorder());
    await expect(
      repo.applyWithRun(
        'acc-1',
        'c1',
        [
          { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'CONVERSATION_STATUS_PENDING' },
          { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' },
        ],
        RUN,
      ),
    ).resolves.toBe(true);

    expect($transaction).toHaveBeenCalledTimes(1);
    const batch = $transaction.mock.calls[0]![0] as unknown[];
    // 2 actions + 1 run record — the record cannot land without the actions, or vice versa.
    // Feature 023: FOUR — the two actions, the run record, and the transition recording the status
    // change. It goes in AFTER the run record on purpose: the at-most-once unique index still decides
    // whether anything lands, so a duplicate delivery rolls back the transition too.
    expect(batch).toHaveLength(4);
  });

  it('is account-scoped (the engine has no human caller — Principle I still applies)', async () => {
    const { prisma, forAccount } = fakePrisma();
    await new AutomationsRepository(prisma, new TransitionRecorder()).applyWithRun(
      'acc-9',
      'c1',
      [{ type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' }],
      RUN,
    );
    expect(forAccount).toHaveBeenCalledWith('acc-9');
  });

  it('*** a duplicate event_key is a successful NO-OP, not an error ***', async () => {
    const { prisma } = fakePrisma({ transaction: jest.fn().mockRejectedValue(P2002) });
    await expect(
      new AutomationsRepository(prisma, new TransitionRecorder()).applyWithRun(
        'acc-1',
        'c1',
        [{ type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' }],
        RUN,
      ),
    ).resolves.toBe(false);
  });

  it('a real database failure still propagates (only P2002 is benign)', async () => {
    const { prisma } = fakePrisma({
      transaction: jest.fn().mockRejectedValue(Object.assign(new Error('down'), { code: 'P1001' })),
    });
    await expect(
      new AutomationsRepository(prisma, new TransitionRecorder()).applyWithRun(
        'acc-1',
        'c1',
        [{ type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' }],
        RUN,
      ),
    ).rejects.toThrow('down');
  });

  it('maps every action type to a write (SET_PRIORITY included)', async () => {
    const { prisma, scoped, $transaction } = fakePrisma();
    await new AutomationsRepository(prisma, new TransitionRecorder()).applyWithRun(
      'acc-1',
      'c1',
      [
        { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'CONVERSATION_STATUS_RESOLVED' },
        { type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'high' },
        { type: 'MACRO_ACTION_TYPE_ASSIGN', value: 'op-1' },
        { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' },
      ],
      RUN,
    );
    // Feature 023: SEVEN — four writes, the run record, and TWO transitions (status + assign).
    // SET_PRIORITY and ADD_LABEL record none: this records the two facts B1 needs, not every column
    // an action touches.
    expect(($transaction.mock.calls[0]![0] as unknown[])).toHaveLength(7);
    const updates = scoped.conversation.updateMany.mock.calls.map((c) => (c[0] as { data: unknown }).data);
    expect(updates).toEqual([
      { status: 'resolved' }, // wire name → storage scalar
      { priority: 'high' },
      { assignee_operator_id: 'op-1' },
    ]);
  });
});

describe('recordRun — no-change outcomes', () => {
  it('writes the record and reports true', async () => {
    const { prisma, runCreate } = fakePrisma();
    await expect(
      new AutomationsRepository(prisma, new TransitionRecorder()).recordRun('acc-1', { ...RUN, outcome: 'not_matched' }),
    ).resolves.toBe(true);
    const data = (runCreate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({
      account_id: 'acc-1',
      automation_id: 'r1',
      automation_revision: 2,
      conversation_id: 'c1',
      event_key: 'msg:m1',
      outcome: 'not_matched',
      reason: null,
    });
  });

  it('reports false — not an error — when the record already exists', async () => {
    const { prisma } = fakePrisma({ runCreate: jest.fn().mockRejectedValue(P2002) });
    await expect(
      new AutomationsRepository(prisma, new TransitionRecorder()).recordRun('acc-1', { ...RUN, outcome: 'refused' }),
    ).resolves.toBe(false);
  });

  // The run record is a diagnostic, and diagnostics must not become a PII sink (FR-020).
  it('stores only ids, an outcome and a short reason — no message text field exists to leak into', async () => {
    const { prisma, runCreate } = fakePrisma();
    await new AutomationsRepository(prisma, new TransitionRecorder()).recordRun('acc-1', {
      ...RUN,
      outcome: 'refused',
      reason: 'author lacks crm.conversation.assign',
    });
    const data = (runCreate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort()).toEqual(
      [
        'account_id',
        'automation_id',
        'automation_revision',
        'conversation_id',
        'event_key',
        'outcome',
        'reason',
        'trigger',
      ].sort(),
    );
  });
});
