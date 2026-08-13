import { Metadata } from '@grpc/grpc-js';
import { DESK_NOT_ROUTABLE, GroupPoolService, defaultCapacity } from './group-pool';
import { GROUP_ROUTING_NOT_AVAILABLE } from './auto-assign.grpc.controller';
import { AuthorityUnavailableError } from '../auth/auth.client';
import { MembershipUnavailableError } from '../person/person-members.client';
import type { PrismaService } from '../prisma.service';
import type { AuthorAuthorityClient } from '../auth/auth.client';
import type { AssignableOperator, PersonMembersClient } from '../person/person-members.client';
import { fakeStatusRepository } from '../status/status.fixture';

/**
 * US3 (feature 024, roadmap 5.3) — turning a GROUP into a routing candidate pool.
 *
 * The pool is assembled from three sources that live in three places: membership in auth, operator
 * profiles in users, current load here. Two of them are gRPC hops, and the single most important
 * property of this module is what it does when one of them **fails**.
 *
 * ⚠️ **An empty pool and a failed lookup must never look alike.** An empty pool is a fact the caller
 * reports honestly (`GROUP_ROUTING_NOT_AVAILABLE`). A failed lookup is an absence of information, and
 * returning `[]` for it would silently stop routing for an entire desk while every request still
 * answered 200 — the failure nobody notices until a shift's worth of work has gone unassigned.
 */
const ENV = { ROUTING_DEFAULT_CAPACITY: '6' } as NodeJS.ProcessEnv;

function make(opts: {
  members?: string[] | Error;
  /** Feature 031: is the desk fed by the router? Defaults to true — see the stub below. */
  routable?: boolean;
  operators?: AssignableOperator[] | Error;
  /**
   * Feature 031: held conversations per operator, with their CHANNEL — the load is measured in units
   * now, and a count cannot express an exclusive channel (ADR 0042 §3).
   */
  load?: { assignee_operator_id: string | null; channel: string | null }[];
}) {
  // Typed with the argument so a spec can read the  the pool built — a mock without it makes
  //  a type error rather than a captured query.
  const findMany = jest.fn(async (args: { select?: Record<string, boolean> }) => (args ? opts.load ?? [] : []));
  const forAccount = jest.fn((accountId: string) => ({ accountId, conversation: { findMany } }));
  const prisma = { forAccount } as unknown as PrismaService;

  const listGroupMembers = jest.fn(async () => {
    if (opts.members instanceof Error) throw opts.members;
    // Feature 031: the desk answers whether the router may feed it. `routable` defaults to TRUE here
    // because every test in this file is about assembling a pool for a desk that IS a queue — the
    // not-routable case has its own spec, where it is the subject rather than the setup.
    return { userIds: opts.members ?? [], routable: opts.routable ?? true };
  });
  const resolveOperators = jest.fn(async () => {
    if (opts.operators instanceof Error) throw opts.operators;
    return opts.operators ?? [];
  });

  const pool = new GroupPoolService(
    prisma,
    { listGroupMembers } as unknown as AuthorAuthorityClient,
    { resolveOperators } as unknown as PersonMembersClient,
    // Feature 032: the load count reads the account's NON-TERMINAL statuses instead of ['open','pending'].
    fakeStatusRepository(),
  );
  return { pool, listGroupMembers, resolveOperators, findMany, forAccount };
}

const md = () => new Metadata();

beforeEach(() => {
  process.env.ROUTING_DEFAULT_CAPACITY = ENV.ROUTING_DEFAULT_CAPACITY;
});

describe('GroupPoolService — assembling the pool', () => {
  it('turns three members into three candidates, in a stable order', async () => {
    const { pool } = make({
      members: ['u-c', 'u-a', 'u-b'],
      operators: [
        { operatorId: 'op-c', authUserId: 'u-c', state: 'online', blockedChannels: [] },
        { operatorId: 'op-a', authUserId: 'u-a', state: 'online', blockedChannels: [] },
        { operatorId: 'op-b', authUserId: 'u-b', state: 'online', blockedChannels: [] },
      ],
    });
    const { candidates: candidates } = await pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1');

    // Sorted, deliberately: the rotation cursor is an INDEX into this list, so an unstable order
    // would point it at a different person between calls and quietly break the fairness property.
    expect(candidates.map((c) => c.operatorId)).toEqual(['op-a', 'op-b', 'op-c']);
    expect(candidates.every((c) => c.capacity === 6)).toBe(true);
    expect(candidates.every((c) => c.currentLoad === 0)).toBe(true);
  });

  it('counts current load from THIS service’s own conversations', async () => {
    const { pool, findMany } = make({
      members: ['u-a', 'u-b'],
      operators: [
        { operatorId: 'op-a', authUserId: 'u-a', state: 'online', blockedChannels: [] },
        { operatorId: 'op-b', authUserId: 'u-b', state: 'online', blockedChannels: [] },
      ],
      load: [{ assignee_operator_id: 'op-a', channel: 'chat' }, { assignee_operator_id: 'op-a', channel: 'chat' }, { assignee_operator_id: 'op-a', channel: 'chat' }, { assignee_operator_id: 'op-a', channel: 'chat' }],
    });
    const { candidates: candidates } = await pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1');

    expect(candidates.find((c) => c.operatorId === 'op-a')!.currentLoad).toBe(4);
    // Absent from the grouped result = nothing open = 0. Not "unknown".
    expect(candidates.find((c) => c.operatorId === 'op-b')!.currentLoad).toBe(0);
    // ONE grouped query, not one per candidate (Principle VII).
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('a member with no ACTIVE operator profile is simply not a candidate', async () => {
    const { pool } = make({
      members: ['u-a', 'u-ghost'],
      operators: [{ operatorId: 'op-a', authUserId: 'u-a', state: 'online', blockedChannels: [] }],
    });
    const { candidates: candidates } = await pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1');
    // Fail-closed: an identity that cannot be resolved to someone who can hold work is not offered
    // work. And the gap between two members and one candidate is what makes a thin pool explainable.
    expect(candidates.map((c) => c.operatorId)).toEqual(['op-a']);
  });

  it('an EMPTY group is an empty pool, and costs no second hop', async () => {
    const { pool, resolveOperators, findMany } = make({ members: [] });
    expect((await pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1')).candidates).toEqual([]);
    expect(resolveOperators).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('a group whose members are ALL unassignable is an empty pool, and costs no load query', async () => {
    const { pool, findMany } = make({ members: ['u-a'], operators: [] });
    expect((await pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1')).candidates).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('every query is scoped to the caller’s account (Principle I)', async () => {
    const { pool, forAccount, listGroupMembers } = make({
      members: ['u-a'],
      operators: [{ operatorId: 'op-a', authUserId: 'u-a', state: 'online', blockedChannels: [] }],
    });
    await pool.candidatesFor('acc-42', 'g-1', md(), null, 'brand-1');
    expect(listGroupMembers).toHaveBeenCalledWith('acc-42', 'g-1');
    expect(forAccount.mock.calls.every((c) => c[0] === 'acc-42')).toBe(true);
  });
});

describe('GroupPoolService — an outage is not an empty desk', () => {
  it('RAISES when auth cannot answer, rather than returning an empty pool', async () => {
    const { pool } = make({ members: new AuthorityUnavailableError('rpc failed') });
    await expect(pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1')).rejects.toBeInstanceOf(
      AuthorityUnavailableError,
    );
  });

  it('RAISES when users cannot answer', async () => {
    const { pool } = make({
      members: ['u-a'],
      operators: new MembershipUnavailableError('rpc failed'),
    });
    await expect(pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1')).rejects.toBeInstanceOf(
      MembershipUnavailableError,
    );
  });

  it('rethrows a REFUSAL with its status intact', async () => {
    // A 403 from users must stay a 403 — "you may not ask this" and "the desk is empty" are different
    // facts, and only one of them is the caller's to fix (the feature-022 lesson).
    const refusal = Object.assign(new Error('forbidden'), { code: 7 });
    const { pool } = make({ members: ['u-a'], operators: refusal });
    await expect(pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1')).rejects.toMatchObject({ code: 7 });
  });
});

describe('defaultCapacity — 🅿 provisional', () => {
  it('reads the configured value', () => {
    expect(defaultCapacity({ ROUTING_DEFAULT_CAPACITY: '9' } as NodeJS.ProcessEnv)).toBe(9);
  });

  it('never yields zero or a negative, which would make every candidate ineligible', () => {
    // The refuse-to-start guard (SEC-6) means production cannot reach these, but a test constructing
    // the class directly can — and a silent 0 would look exactly like "everyone is at capacity".
    for (const raw of ['0', '-3', 'abc', '', undefined]) {
      expect(
        defaultCapacity({ ROUTING_DEFAULT_CAPACITY: raw } as NodeJS.ProcessEnv),
      ).toBeGreaterThan(0);
    }
  });
});

/**
 * T015d (feature 031, ADR 0042 — option C) — **a desk nobody marked receives no pushed work.**
 *
 * ⚠️ This asserts the **OUTCOME**, and that is the whole point of it. Feature 030's guard
 * (`am-not-a-queue-agent-030.spec.ts`) forbids routing modules from *naming* an account-manager role, and
 * it was green throughout while the pool was built from group MEMBERSHIP alone — so an AM in a routed
 * group could be auto-assigned, exactly what roadmap 4.14 promised would not happen.
 *
 * ⇒ **A guard against naming a thing is not a proof that the thing cannot happen.** The rule was enforced
 * at the vocabulary and never at the result. This is the missing half.
 */
describe('T015d — routability is a property of the DESK', () => {
  it('⭐ a non-routable desk yields NO candidates, whoever staffs it', async () => {
    const { pool } = make({ routable: false, members: ['u-1', 'u-2'], operators: [
      { operatorId: 'op-1', authUserId: 'u-1', state: 'online', blockedChannels: [] },
      { operatorId: 'op-2', authUserId: 'u-2', state: 'online', blockedChannels: [] },
    ] });

    const out = await pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1');
    expect(out.candidates).toEqual([]);
  });

  it('⭐ POSITIVE CONTROL: the SAME desk, marked routable, yields candidates', async () => {
    // Without this line the assertion above is satisfied by a pool that returns nobody for any reason —
    // a broken stub, an empty membership, a resolver that failed quietly.
    const { pool } = make({ routable: true, members: ['u-1'], operators: [
      { operatorId: 'op-1', authUserId: 'u-1', state: 'online', blockedChannels: [] },
    ] });

    const out = await pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1');
    expect(out.candidates.map((c) => c.operatorId)).toEqual(['op-1']);
    expect(out.reason).toBeNull();
  });

  it('⚠️ refuses with its OWN reason, not "the pool could not be resolved"', async () => {
    // `GROUP_ROUTING_NOT_AVAILABLE` means the staffing is unknown. Conflating it with "this desk is not a
    // queue" would send an administrator to look at rotas when the answer is a checkbox.
    const { pool } = make({ routable: false, members: ['u-1'] });
    const out = await pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1');
    expect(out.reason).toBe(DESK_NOT_ROUTABLE);
    expect(out.reason).not.toBe(GROUP_ROUTING_NOT_AVAILABLE);
  });

  it('costs no second hop — a desk that is not a queue is answered before resolving anybody', async () => {
    const { pool, resolveOperators } = make({ routable: false, members: ['u-1', 'u-2'] });
    await pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1');
    expect(resolveOperators).not.toHaveBeenCalled();
  });
});

/**
 * T010 (feature 031, roadmap 4.21 / ADR 0042 §3) — **why units, and not a count of conversations.**
 *
 * The shipped gate compared a row count against one flat number. That cannot express "this person is on a
 * voice call, so they are unavailable regardless of how few rows they hold" — and the test below is the
 * case that proves it: **one** held conversation, a budget of six, and the agent is still full.
 */
describe('T010 — capacity is measured in UNITS', () => {
  const online = (id: string) => ({ operatorId: id, authUserId: `u-${id}`, state: 'online' as const, blockedChannels: [] });

  it('⭐ one EXCLUSIVE conversation fills an agent a row count would call nearly empty', async () => {
    const { pool } = make({
      members: ['u-op-1'],
      operators: [online('op-1')],
      load: [{ assignee_operator_id: 'op-1', channel: 'voice' }],
    });

    const { candidates } = await pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1');
    // ENV budget is 6. A count of conversations would report 1 of 6 used — five slots free.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.currentLoad).toBe(candidates[0]!.capacity);
  });

  it('⭐ POSITIVE CONTROL: the same agent holding one CHAT has room', async () => {
    const { pool } = make({
      members: ['u-op-1'],
      operators: [online('op-1')],
      load: [{ assignee_operator_id: 'op-1', channel: 'chat' }],
    });

    const { candidates } = await pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1');
    expect(candidates[0]!.currentLoad).toBeLessThan(candidates[0]!.capacity);
  });

  it('an absent channel still costs a unit — it is work like any other', async () => {
    const { pool } = make({
      members: ['u-op-1'],
      operators: [online('op-1')],
      load: [{ assignee_operator_id: 'op-1', channel: null }, { assignee_operator_id: 'op-1', channel: null }],
    });

    const { candidates } = await pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1');
    expect(candidates[0]!.currentLoad).toBe(2);
  });

  it('⛔ the load read carries only the channel — no subject, no player, no body (Principle IV)', async () => {
    const { pool, findMany } = make({ members: ['u-op-1'], operators: [online('op-1')] });
    await pool.candidatesFor('acc-1', 'g-1', md(), null, 'brand-1');
    const select = findMany.mock.calls[0]?.[0]?.select ?? {};
    expect(Object.keys(select).sort()).toEqual(['assignee_operator_id', 'channel']);
  });
});
