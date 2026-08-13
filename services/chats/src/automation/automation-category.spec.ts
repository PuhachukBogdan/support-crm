import type { PrismaService } from '../prisma.service';
import type { AutomationTrigger } from '../events/events.types';
import type { MacroAction } from '../macros/macro-definition';
import { MACRO_ACTION_TYPES } from '../macros/macro-definition';
import { TransitionRecorder } from '../transition/transition.recorder';
import { userActor } from '../transition/conversation-transitions';
import { fakeStatusRepository } from '../status/status.fixture';
import { MacrosRepository } from '../macros/macros.repository';
import { AutomationsRepository, type RunRecord } from './automations.repository';

/**
 * ⭐⭐ Feature 037 (roadmap 4.15 — W30, US4) — the automation batch survives its own vocabulary,
 * and the U9 writer-precedence lock is STRUCTURAL.
 *
 * ── The defect pin (FR-015 / SC-005) ─────────────────────────────────────────────────────────────
 * SET_CATEGORY / SET_SUB_CATEGORY have been in the shared action vocabulary since feature 014 and
 * `rule-definition` accepts them at define — but until W30 `applyWithRun`'s switch had NO case for
 * either: the map yielded `undefined` and the whole apply batch died. The first test FAILS on the
 * old code (an `undefined` lands in the batch and the category never lands in the row).
 *
 * ── The lock (FR-013) ────────────────────────────────────────────────────────────────────────────
 * An automated writer's WHERE carries `classificationLock`: a human-locked row matches ZERO rows —
 * a structural no-op, not an error, and not a check any caller has to remember. A human (macro)
 * write carries an EMPTY lock extension and always wins.
 */

type Row = Record<string, unknown>;

function matchesWhere(row: Row, where?: Row): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === 'OR') {
      if (!(v as Row[]).some((w) => matchesWhere(row, w))) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

function fakeWorld(convoOver: Row = {}) {
  const convo: Row = {
    id: 'c1',
    account_id: 'acc-1',
    status: 'open',
    brand_id: 'brand-a',
    channel: 'web',
    assignee_operator_id: null,
    form_key: null,
    category: null,
    sub_category: null,
    classified_by: null,
    priority: null,
    priority_rank: 0,
    ...convoOver,
  };
  const batches: unknown[][] = [];
  const updateCalls: Array<{ where: Row; data: Row }> = [];

  const scoped = {
    conversation: {
      findFirst: async () => ({ ...convo }),
      updateMany: (args: { where: Row; data: Row }) => {
        updateCalls.push(args);
        const hit = matchesWhere(convo, args.where);
        if (hit) Object.assign(convo, args.data);
        return { count: hit ? 1 : 0, __stmt: 'conversation.updateMany' };
      },
    },
    conversationLabel: {
      upsert: () => ({ __stmt: 'link.upsert' }),
    },
    conversationTransition: {
      create: (a: { data: Row }) => ({ __stmt: 'transition.create', data: a.data }),
    },
    automationRun: {
      create: (a: { data: Row }) => ({ __stmt: 'run.create', data: a.data }),
    },
    macroApplication: {
      create: () => ({ __stmt: 'usage.create' }),
    },
    $transaction: (batch: unknown[]) => {
      batches.push(batch);
      return Promise.resolve(batch.map((s) => s ?? {}));
    },
  };
  const prisma = { forAccount: jest.fn(() => scoped) } as unknown as PrismaService;
  return { prisma, convo, batches, updateCalls };
}

const run: RunRecord = {
  automationId: 'rule-1',
  automationRevision: 1,
  conversationId: 'c1',
  trigger: 'conversation.created' as AutomationTrigger,
  eventKey: 'evt-1',
  outcome: 'applied',
};

const act = (type: string, value: string): MacroAction => ({ type: type as MacroAction['type'], value });

const automations = (prisma: PrismaService) =>
  new AutomationsRepository(prisma, new TransitionRecorder());

describe('⭐⭐ the pin (FR-015): a rule with SET_CATEGORY applies WITHOUT killing its own batch', () => {
  it('every action lands, no statement is undefined, category + classified_by=ai are written', async () => {
    const w = fakeWorld();
    const ok = await automations(w.prisma).applyWithRun(
      'acc-1',
      'c1',
      [
        act('MACRO_ACTION_TYPE_SET_CATEGORY', 'Deposits'),
        act('MACRO_ACTION_TYPE_SET_SUB_CATEGORY', 'Deposit status'),
        // A neighbour action in the SAME batch — "does not abort" means the others land too.
        act('MACRO_ACTION_TYPE_SET_PRIORITY', 'high'),
      ],
      run,
    );

    expect(ok).toBe(true);
    // The old code's exact failure signature: the switch had no case, the map yielded `undefined`,
    // and the batch handed to Postgres died. This line fails on the old code.
    expect(w.batches[0]!.every((s) => s !== undefined)).toBe(true);

    expect(w.convo).toMatchObject({
      category: 'Deposits',
      sub_category: 'Deposit status',
      classified_by: 'ai', // an automation is an AUTOMATED writer — never the rule author's id
      priority: 'high', // the neighbour landed too
    });
    // The at-most-once run record rides the SAME transaction as the actions.
    expect(w.batches[0]!).toContainEqual(expect.objectContaining({ __stmt: 'run.create' }));
  });

  it('the automated write carries the lock PREDICATE in its WHERE — structural, not a comment', async () => {
    const w = fakeWorld();
    await automations(w.prisma).applyWithRun(
      'acc-1',
      'c1',
      [act('MACRO_ACTION_TYPE_SET_CATEGORY', 'Deposits')],
      run,
    );
    expect(w.updateCalls[0]!.where).toEqual({
      id: 'c1',
      OR: [{ classified_by: null }, { classified_by: 'ai' }],
    });
  });
});

describe('⭐ U9 — writer precedence as a predicate (FR-013)', () => {
  it('an automated write over a HUMAN lock matches zero rows: the human value stands, no error', async () => {
    const w = fakeWorld({ category: 'Handled', classified_by: 'op-1' });
    const ok = await automations(w.prisma).applyWithRun(
      'acc-1',
      'c1',
      [act('MACRO_ACTION_TYPE_SET_CATEGORY', 'Spam')],
      run,
    );
    expect(ok).toBe(true); // the batch itself commits — a no-op is not a failure
    expect(w.convo).toMatchObject({ category: 'Handled', classified_by: 'op-1' });
  });

  it("an automated write over the automated mark ('ai') applies — only a human locks", async () => {
    const w = fakeWorld({ category: 'Old guess', classified_by: 'ai' });
    await automations(w.prisma).applyWithRun(
      'acc-1',
      'c1',
      [act('MACRO_ACTION_TYPE_SET_CATEGORY', 'New guess')],
      run,
    );
    expect(w.convo).toMatchObject({ category: 'New guess', classified_by: 'ai' });
  });

  it('⭐ a HUMAN (macro) write over the automated mark WINS and locks — the U9 direction', async () => {
    const w = fakeWorld({ category: 'Old guess', classified_by: 'ai' });
    await new MacrosRepository(w.prisma, new TransitionRecorder(), fakeStatusRepository()).applyActions(
      'acc-1',
      'c1',
      'm-1',
      [act('MACRO_ACTION_TYPE_SET_CATEGORY', 'Payments')],
      userActor('op-9'),
    );
    expect(w.convo).toMatchObject({ category: 'Payments', classified_by: 'op-9' });
    // The human write's WHERE carries NO lock extension: it always applies.
    const write = w.updateCalls.find((u) => 'category' in u.data)!;
    expect('OR' in write.where).toBe(false);
  });
});

describe('FR-014 — the automated vocabulary offers NO subject and NO form write path', () => {
  it('no action type touches the subject or the form choice', () => {
    // The auto-classifier's future surface is category, sub-category and labels; subject stays
    // behind its own lock and the form choice behind the human rpc. The vocabulary is the proof.
    for (const type of MACRO_ACTION_TYPES) {
      expect(type).not.toMatch(/SUBJECT|FORM/);
    }
  });
});
