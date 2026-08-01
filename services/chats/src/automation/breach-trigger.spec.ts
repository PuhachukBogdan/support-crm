import { Metadata } from '@grpc/grpc-js';
import { AutomationEngine } from './engine';
import { AutomationsRepository } from './automations.repository';
import { DomainEventDispatcher } from '../events/events.dispatcher';
import { DomainEventPublisher } from '../events/events.publisher';
import { SlaMaintenanceController } from '../sla/sla.grpc.controller';
import { SlaRepository } from '../sla/sla.repository';
import { SlaSweepRepository } from '../sla/sla-sweep.repository';
import { LabelsRepository } from '../labels/labels.repository';
import type { AuthorAuthorityClient } from '../auth/auth.client';
import type { PrismaService } from '../prisma.service';
import type { ConversationRepository } from '../conversation/conversation.repository';
import { TransitionRecorder } from '../transition/transition.recorder';

/**
 * T048 (feature 014, US3) — **the join**: a missed first-reply target is an event, so a rule can react
 * to it. This wires the real pieces together (sweep → mark → publish → engine → write) with only Prisma
 * faked, because the value of US3 is precisely that the two halves meet correctly.
 *
 * Four properties, each a way this could go wrong:
 *  1. a breach fires its rules;
 *  2. it fires **exactly once, ever** — a second sweep must not re-announce it (`breach_announced_at`
 *     plus the timestamp-free `breach:<id>` event key);
 *  3. a breach with **no** rule listening is still recorded and listable — the measurement never
 *     depends on a rule existing;
 *  4. the breach rule's own writes do not re-arm the measurement or trigger further rules.
 */
const CONV = 'c-breach';
const ACC = 'acc-1';

const BREACH_RULE = {
  id: 'r-breach',
  name: 'escalate on breach',
  active: true,
  position: 0,
  revision: 1,
  author_user_id: 'author-1',
  definition: {
    trigger: 'AUTOMATION_TRIGGER_FIRST_REPLY_BREACHED',
    conditions: [],
    actions: [
      { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l-1' },
      { type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'high' },
    ],
  },
  created_at: new Date('2026-07-27T10:00:00.000Z'),
  updated_at: new Date('2026-07-27T10:00:00.000Z'),
};

/**
 * One in-memory row per table, enough to observe the announce-once transition.
 *
 * ⚠️ The fake models Prisma's **lazy batch** semantics deliberately: a statement built by
 * `db.x.y(...)` does nothing until `$transaction` runs it, and if any statement in the batch throws,
 * the whole batch is rolled back. An eager fake would let a rolled-back label write "stick" and would
 * therefore hide exactly the atomicity regression these tests exist to catch.
 */
function world(opts: { rules?: unknown[] } = {}) {
  const state = {
    id: 's1',
    conversation_id: CONV,
    account_id: ACC,
    outcome: 'running',
    started_at: new Date('2026-07-27T10:00:00.000Z'),
    deadline_at: new Date('2026-07-27T10:01:00.000Z'),
    target_minutes: 1,
    first_reply_at: null as Date | null,
    first_reply_seconds: null as number | null,
    breach_announced_at: null as Date | null,
  };
  const runs: Record<string, unknown>[] = [];
  const conversationWrites: Record<string, unknown>[] = [];
  const transitionWrites: Record<string, unknown>[] = [];
  const labelLinks: Record<string, unknown>[] = [];

  /** A deferred statement, as Prisma's PrismaPromise is for practical purposes inside $transaction. */
  type Deferred = { __run: () => void };
  const defer = (run: () => void): Deferred => ({ __run: run });

  const scoped = {
    conversationSlaState: {
      findFirst: () => Promise.resolve(state),
      findMany: () => Promise.resolve([state]),
      updateMany: (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        // Reproduce the guards that make the transition happen at most once.
        if (a.where.outcome === 'running' && state.outcome !== 'running') {
          return Promise.resolve({ count: 0 });
        }
        if (a.where.breach_announced_at === null && state.breach_announced_at !== null) {
          return Promise.resolve({ count: 0 });
        }
        Object.assign(state, a.data);
        return Promise.resolve({ count: 1 });
      },
    },
    automation: { findMany: () => Promise.resolve(opts.rules ?? [BREACH_RULE]) },
    automationRun: {
      create: (a: { data: Record<string, unknown> }) =>
        defer(() => {
          // The unique (automation_id, conversation_id, event_key) constraint, in memory.
          const dup = runs.some(
            (r) =>
              r.automation_id === a.data.automation_id &&
              r.conversation_id === a.data.conversation_id &&
              r.event_key === a.data.event_key,
          );
          if (dup) throw Object.assign(new Error('unique'), { code: 'P2002' });
          runs.push(a.data);
        }),
    },
    label: { findFirst: () => Promise.resolve({ id: 'l-1' }) },
    conversationLabel: {
      findMany: () => Promise.resolve([]),
      upsert: (a: Record<string, unknown>) => defer(() => void labelLinks.push(a)),
    },
    conversation: {
      updateMany: (a: Record<string, unknown>) => defer(() => void conversationWrites.push(a)),
      // Feature 023: awaited before assembly; the writes themselves stay in the batch.
      findFirst: async () => ({
        id: 'c1',
        status: 'open',
        brand_id: 'brand-a',
        channel: null,
        assignee_operator_id: null,
      }),
    },
    conversationTransition: {
      create: (a: Record<string, unknown>) => defer(() => void transitionWrites.push(a)),
    },
  } as Record<string, unknown>;

  scoped.$transaction = async (arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(scoped);
    // Snapshot → run the batch → restore on any failure. That IS the atomicity being asserted.
    const snapshot = {
      runs: [...runs],
      conversationWrites: [...conversationWrites],
      labelLinks: [...labelLinks],
    };
    try {
      for (const stmt of arg as Deferred[]) stmt.__run();
      return [];
    } catch (err) {
      runs.length = 0;
      runs.push(...snapshot.runs);
      conversationWrites.length = 0;
      conversationWrites.push(...snapshot.conversationWrites);
      labelLinks.length = 0;
      labelLinks.push(...snapshot.labelLinks);
      throw err;
    }
  };

  const prisma = {
    forAccount: jest.fn(() => scoped),
    // The sweep's base-client read: due while running and not yet announced.
    conversationSlaState: {
      findMany: jest.fn(async () =>
        state.outcome === 'running' && state.breach_announced_at === null
          ? [{ account_id: ACC, conversation_id: CONV }]
          : [],
      ),
    },
  } as unknown as PrismaService;

  return { prisma, state, runs, conversationWrites, labelLinks };
}

function assemble(w: ReturnType<typeof world>) {
  const automations = new AutomationsRepository(w.prisma, new TransitionRecorder());
  const engine = new AutomationEngine(
    automations,
    new LabelsRepository(w.prisma),
    {
      resolve: jest.fn(async () => ({
        roleKey: 'teamlead',
        permissionKeys: ['crm.labels.manage', 'crm.conversation.reply'],
      })),
    } as unknown as AuthorAuthorityClient,
  );
  const dispatcher = new DomainEventDispatcher();
  dispatcher.subscribe((e) => engine.handle(e));

  const publisher = new DomainEventPublisher(
    dispatcher,
    {
      getById: jest.fn(async () => ({
        id: CONV,
        brand_id: 'b1',
        player_id: 'p1',
        status: 'open',
        priority: 'normal',
        assignee_operator_id: null,
        channel: 'web',
        reference: null,
        category: null,
        sub_category: null,
        classified_by: null,
        created_at: new Date(),
        updated_at: new Date(),
      })) as never,
    } as unknown as ConversationRepository,
    automations,
  );

  const controller = new SlaMaintenanceController(
    new SlaRepository(w.prisma),
    new SlaSweepRepository(w.prisma),
    publisher,
  );
  const md = new Metadata();
  md.set('x-actor-kind', 'system');
  return { controller, md, dispatcher };
}

describe('a breach triggers rules (US3)', () => {
  it('applies the breach rule’s actions with no operator action', async () => {
    const w = world();
    const { controller, md } = assemble(w);
    const res = await controller.sweepFirstReplySla({ limit: 10 }, md);

    expect(res).toEqual({ checked: 1, breached: 1, rulesApplied: 1 });
    expect(w.state.outcome).toBe('breached');
    expect(w.state.breach_announced_at).not.toBeNull();
    expect(w.labelLinks).toHaveLength(1);
    expect(w.conversationWrites[0]).toMatchObject({ data: { priority: 'high' } });
    expect(w.runs[0]).toMatchObject({ outcome: 'applied', event_key: `breach:${CONV}` });
  });

  it('*** a second sweep does NOT re-announce or re-apply ***', async () => {
    const w = world();
    const { controller, md } = assemble(w);
    await controller.sweepFirstReplySla({ limit: 10 }, md);
    const second = await controller.sweepFirstReplySla({ limit: 10 }, md);

    // The row no longer matches the sweep predicate, so there is nothing even to check.
    expect(second).toEqual({ checked: 0, breached: 0, rulesApplied: 0 });
    expect(w.runs).toHaveLength(1);
    expect(w.labelLinks).toHaveLength(1);
  });

  it('the timestamp-free event key would refuse a re-application even if the row were re-swept', async () => {
    const w = world();
    const { controller, md } = assemble(w);
    await controller.sweepFirstReplySla({ limit: 10 }, md);
    // Force the row back into a sweepable state WITHOUT clearing the run record — the belt to the
    // announce-once braces. The unique (rule, conversation, breach:<id>) key must refuse the second
    // application, so nothing is applied twice.
    w.state.outcome = 'running';
    w.state.breach_announced_at = null;
    const again = await controller.sweepFirstReplySla({ limit: 10 }, md);
    expect(again.breached).toBe(1); // the row was marked again…
    expect(again.rulesApplied).toBe(0); // …but the rule did NOT apply again
    expect(w.runs).toHaveLength(1);
    expect(w.labelLinks).toHaveLength(1);
  });

  it('a breach with NO rule listening is still recorded and listable', async () => {
    const w = world({ rules: [] });
    const { controller, md } = assemble(w);
    const res = await controller.sweepFirstReplySla({ limit: 10 }, md);
    expect(res).toEqual({ checked: 1, breached: 1, rulesApplied: 0 });
    expect(w.state.outcome).toBe('breached'); // the measurement never depends on a rule
    expect(w.runs).toHaveLength(0);
  });

  it('the breach rule’s own writes do not re-arm the measurement or cascade', async () => {
    const w = world();
    const { controller, md, dispatcher } = assemble(w);
    const publishSpy = jest.spyOn(dispatcher, 'publish');
    await controller.sweepFirstReplySla({ limit: 10 }, md);

    // Exactly one publish: the breach. The rule's own label/priority writes emitted nothing (R4).
    expect(publishSpy).toHaveBeenCalledTimes(1);
    // And the measurement stayed decided — a rule cannot restart a clock.
    expect(w.state.outcome).toBe('breached');
    expect(w.state.first_reply_at).toBeNull();
  });
});
