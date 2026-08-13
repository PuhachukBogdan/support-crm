import { RoundRobinStateRepository } from './round-robin-state.repository';
import { TransitionRecorder } from '../transition/transition.recorder';
import type { PrismaService } from '../prisma.service';

/**
 * ⭐ SC-010 / research R8 (feature 031, roadmap 4.20/4.21) — **two routers must not over-allocate a unit.**
 *
 * ── Found live, on the second Track B run ───────────────────────────────────────────────────────
 * Two concurrent auto-assign calls with ONE free unit both returned `assigned: true`, and the agent ended
 * up holding **7 of 6**. Everything about capacity lived in the POOL, computed before the transaction
 * opened, so both requests read the same load and both passed. The transaction serialised the *cursor* —
 * and this file's subject header claimed that prevented exactly this — which makes the rotation fair and
 * says nothing about the budget.
 *
 * ⚠️ The Track-A test that "proved" concurrency was safe asserted that the cursor read and the assignment
 * happen in one transaction. True, and irrelevant: the number being checked was decided outside it.
 *
 * ── What is asserted here ───────────────────────────────────────────────────────────────────────
 * The three things the fix consists of, each provable without a database:
 *   1. a lock is taken on the CHOSEN OPERATOR before anything is decided;
 *   2. the load is re-read INSIDE that lock and the budget re-applied — a candidate who was free when the
 *      pool was built and is full now is refused;
 *   3. the claim is conditional on the conversation still being unowned.
 */

interface Fake {
  held: { channel: string | null }[];
  claimCount?: number;
  before?: Record<string, unknown> | null;
}

function fake(opts: Fake) {
  const calls: string[] = [];
  const updateMany = jest.fn(async (args: { where: Record<string, unknown> }) => {
    calls.push('update');
    void args;
    return { count: opts.claimCount ?? 1 };
  });
  const executeRawUnsafe = jest.fn(async (sql: string, ...values: unknown[]) => {
    calls.push(`lock:${String(values[0])}`);
    void sql;
    return 1;
  });
  const findMany = jest.fn(async () => {
    calls.push('read-load');
    return opts.held;
  });
  const scoped = {
    conversation: {
      findFirst: jest.fn(async () =>
        opts.before === undefined ? { id: 'c1', assignee_operator_id: null } : opts.before,
      ),
      findMany,
      updateMany,
    },
    roundRobinState: {
      findFirst: jest.fn(async () => null),
      updateMany: jest.fn(async () => ({ count: 1 })),
      create: jest.fn(async () => ({ id: 'rr1' })),
    },
    conversationTransition: { create: jest.fn(async () => undefined) },
    $executeRawUnsafe: executeRawUnsafe,
  } as Record<string, unknown>;
  scoped.$transaction = jest.fn(function (this: unknown, cb: (tx: unknown) => unknown) {
    return cb(scoped);
  });
  const prisma = { forAccount: jest.fn(() => scoped) } as unknown as PrismaService;
  const repo = new RoundRobinStateRepository(prisma, new TransitionRecorder());
  return { repo, updateMany, executeRawUnsafe, findMany, calls };
}

const cand = (operatorId: string, capacity = 6) => ({ operatorId, capacity, currentLoad: 0 });

describe('the claim re-checks the budget under a lock', () => {
  it('⭐ refuses when the operator is ALREADY at budget, whatever the pool believed', async () => {
    // The pool said `currentLoad: 0` — it was true when the pool was built. Six conversations are in hand
    // now, and this is the read that notices.
    const { repo, updateMany } = fake({ held: Array.from({ length: 6 }, () => ({ channel: 'chat' })) });

    const res = await repo.selectAndAssign('acc-1', 'c1', 'g-1', [cand('op-a')]);

    expect(res).toEqual({ operatorId: null });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('⭐ POSITIVE CONTROL: with room, it assigns', async () => {
    // Without this, the refusal above is satisfied by a claim path that refuses everything.
    const { repo, updateMany } = fake({ held: [{ channel: 'chat' }] });
    const res = await repo.selectAndAssign('acc-1', 'c1', 'g-1', [cand('op-a')]);
    expect(res).toEqual({ operatorId: 'op-a' });
    expect(updateMany).toHaveBeenCalled();
  });

  it('⚠️ an EXCLUSIVE conversation in hand means full, whatever the number says', async () => {
    // One voice call and five free units is still full: the channel owns the person.
    const { repo } = fake({ held: [{ channel: 'voice' }] });
    expect(await repo.selectAndAssign('acc-1', 'c1', 'g-1', [cand('op-a')])).toEqual({
      operatorId: null,
    });
  });

  it('⭐ the lock is taken on the CHOSEN OPERATOR, before the load is read', async () => {
    // Order matters: reading the load first and locking afterwards leaves the same race with extra steps.
    const { repo, calls } = fake({ held: [] });
    await repo.selectAndAssign('acc-1', 'c1', 'g-1', [cand('op-a')]);
    expect(calls[0]).toBe('lock:acc-1:op-a');
    expect(calls[1]).toBe('read-load');
  });

  it('⚠️ the lock key carries the ACCOUNT, so two accounts never contend', async () => {
    const { repo, executeRawUnsafe } = fake({ held: [] });
    await repo.selectAndAssign('acc-42', 'c1', 'g-1', [cand('op-a')]);
    expect(executeRawUnsafe.mock.calls[0]![1]).toBe('acc-42:op-a');
  });

  it('⭐ the claim is CONDITIONAL on the conversation still being unowned', async () => {
    const { repo, updateMany } = fake({ held: [] });
    await repo.selectAndAssign('acc-1', 'c1', 'g-1', [cand('op-a')]);
    expect(updateMany.mock.calls[0]![0].where).toEqual({ id: 'c1', assignee_operator_id: null });
  });

  it('⭐ losing that claim is answered as "nobody", not as a successful assignment', async () => {
    // `count: 0` means another router got there first. The caller queues or skips — the paths that already
    // exist for "somebody took the slot".
    const { repo } = fake({ held: [], claimCount: 0 });
    expect(await repo.selectAndAssign('acc-1', 'c1', 'g-1', [cand('op-a')])).toEqual({
      operatorId: null,
    });
  });

  it('⚠️ a DELIBERATE re-route still writes unconditionally', async () => {
    // A conversation that already has an owner is being reassigned on purpose (feature 013). Adding the
    // unowned guard there would turn a reassignment into a silent refusal.
    const { repo, updateMany } = fake({
      held: [],
      before: { id: 'c1', assignee_operator_id: 'op-old' },
    });
    await repo.selectAndAssign('acc-1', 'c1', 'g-1', [cand('op-a')]);
    expect(updateMany.mock.calls[0]![0].where).toEqual({ id: 'c1' });
  });
});
