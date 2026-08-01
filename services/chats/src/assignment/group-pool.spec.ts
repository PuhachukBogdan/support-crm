import { Metadata } from '@grpc/grpc-js';
import { GroupPoolService, defaultCapacity } from './group-pool';
import { AuthorityUnavailableError } from '../auth/auth.client';
import { MembershipUnavailableError } from '../person/person-members.client';
import type { PrismaService } from '../prisma.service';
import type { AuthorAuthorityClient } from '../auth/auth.client';
import type { AssignableOperator, PersonMembersClient } from '../person/person-members.client';

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
  operators?: AssignableOperator[] | Error;
  load?: { assignee_operator_id: string | null; _count: { _all: number } }[];
}) {
  const groupBy = jest.fn(async () => opts.load ?? []);
  const forAccount = jest.fn((accountId: string) => ({ accountId, conversation: { groupBy } }));
  const prisma = { forAccount } as unknown as PrismaService;

  const listGroupMembers = jest.fn(async () => {
    if (opts.members instanceof Error) throw opts.members;
    return opts.members ?? [];
  });
  const resolveOperators = jest.fn(async () => {
    if (opts.operators instanceof Error) throw opts.operators;
    return opts.operators ?? [];
  });

  const pool = new GroupPoolService(
    prisma,
    { listGroupMembers } as unknown as AuthorAuthorityClient,
    { resolveOperators } as unknown as PersonMembersClient,
  );
  return { pool, listGroupMembers, resolveOperators, groupBy, forAccount };
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
    const candidates = await pool.candidatesFor('acc-1', 'g-1', md());

    // Sorted, deliberately: the rotation cursor is an INDEX into this list, so an unstable order
    // would point it at a different person between calls and quietly break the fairness property.
    expect(candidates.map((c) => c.operatorId)).toEqual(['op-a', 'op-b', 'op-c']);
    expect(candidates.every((c) => c.capacity === 6)).toBe(true);
    expect(candidates.every((c) => c.currentLoad === 0)).toBe(true);
  });

  it('counts current load from THIS service’s own conversations', async () => {
    const { pool, groupBy } = make({
      members: ['u-a', 'u-b'],
      operators: [
        { operatorId: 'op-a', authUserId: 'u-a', state: 'online', blockedChannels: [] },
        { operatorId: 'op-b', authUserId: 'u-b', state: 'online', blockedChannels: [] },
      ],
      load: [{ assignee_operator_id: 'op-a', _count: { _all: 4 } }],
    });
    const candidates = await pool.candidatesFor('acc-1', 'g-1', md());

    expect(candidates.find((c) => c.operatorId === 'op-a')!.currentLoad).toBe(4);
    // Absent from the grouped result = nothing open = 0. Not "unknown".
    expect(candidates.find((c) => c.operatorId === 'op-b')!.currentLoad).toBe(0);
    // ONE grouped query, not one per candidate (Principle VII).
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it('a member with no ACTIVE operator profile is simply not a candidate', async () => {
    const { pool } = make({
      members: ['u-a', 'u-ghost'],
      operators: [{ operatorId: 'op-a', authUserId: 'u-a', state: 'online', blockedChannels: [] }],
    });
    const candidates = await pool.candidatesFor('acc-1', 'g-1', md());
    // Fail-closed: an identity that cannot be resolved to someone who can hold work is not offered
    // work. And the gap between two members and one candidate is what makes a thin pool explainable.
    expect(candidates.map((c) => c.operatorId)).toEqual(['op-a']);
  });

  it('an EMPTY group is an empty pool, and costs no second hop', async () => {
    const { pool, resolveOperators, groupBy } = make({ members: [] });
    expect(await pool.candidatesFor('acc-1', 'g-1', md())).toEqual([]);
    expect(resolveOperators).not.toHaveBeenCalled();
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('a group whose members are ALL unassignable is an empty pool, and costs no load query', async () => {
    const { pool, groupBy } = make({ members: ['u-a'], operators: [] });
    expect(await pool.candidatesFor('acc-1', 'g-1', md())).toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('every query is scoped to the caller’s account (Principle I)', async () => {
    const { pool, forAccount, listGroupMembers } = make({
      members: ['u-a'],
      operators: [{ operatorId: 'op-a', authUserId: 'u-a', state: 'online', blockedChannels: [] }],
    });
    await pool.candidatesFor('acc-42', 'g-1', md());
    expect(listGroupMembers).toHaveBeenCalledWith('acc-42', 'g-1');
    expect(forAccount.mock.calls.every((c) => c[0] === 'acc-42')).toBe(true);
  });
});

describe('GroupPoolService — an outage is not an empty desk', () => {
  it('RAISES when auth cannot answer, rather than returning an empty pool', async () => {
    const { pool } = make({ members: new AuthorityUnavailableError('rpc failed') });
    await expect(pool.candidatesFor('acc-1', 'g-1', md())).rejects.toBeInstanceOf(
      AuthorityUnavailableError,
    );
  });

  it('RAISES when users cannot answer', async () => {
    const { pool } = make({
      members: ['u-a'],
      operators: new MembershipUnavailableError('rpc failed'),
    });
    await expect(pool.candidatesFor('acc-1', 'g-1', md())).rejects.toBeInstanceOf(
      MembershipUnavailableError,
    );
  });

  it('rethrows a REFUSAL with its status intact', async () => {
    // A 403 from users must stay a 403 — "you may not ask this" and "the desk is empty" are different
    // facts, and only one of them is the caller's to fix (the feature-022 lesson).
    const refusal = Object.assign(new Error('forbidden'), { code: 7 });
    const { pool } = make({ members: ['u-a'], operators: refusal });
    await expect(pool.candidatesFor('acc-1', 'g-1', md())).rejects.toMatchObject({ code: 7 });
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
