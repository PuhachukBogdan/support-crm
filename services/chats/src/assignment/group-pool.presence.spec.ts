import { GroupPoolService } from './group-pool';
import { MembershipUnavailableError } from '../person/person-members.client';
import type { AssignableOperator, PersonMembersClient } from '../person/person-members.client';
import type { AuthorAuthorityClient } from '../auth/auth.client';
import type { PrismaService } from '../prisma.service';
import type { Metadata } from '@grpc/grpc-js';

/**
 * T023 (feature 025, roadmap 5.9 — US1 / FR-029..FR-031): **routing consumes availability, and an
 * empty pool still means what it meant.**
 *
 * ── The property that must survive, not merely still pass ───────────────────────────────────────
 * Feature 024's header guarantees that an empty pool means *"this desk has nobody available"* — a
 * fact reported honestly — and **never** *"I could not find out"*. Feature 025 adds a second reason
 * for a pool to be empty, so the guarantee has to be re-proved rather than assumed: the new filter
 * must narrow the set for a REASON, and an unreachable users service must still raise.
 *
 * ── Why both wrong defaults are asserted absent ─────────────────────────────────────────────────
 * When availability cannot be established there are two tempting fallbacks and both are wrong in
 * different directions: "assume available" pushes a live customer at somebody who may be asleep;
 * "assume unavailable" stops a whole desk while every request still answers 200. Testing only that
 * the right thing happens would pass for code that silently picked either — so the absence of both
 * is asserted explicitly.
 */

const md = {} as Metadata;

const op = (
  id: string,
  state: AssignableOperator['state'] = 'online',
  blockedChannels: string[] = [],
): AssignableOperator => ({ operatorId: id, authUserId: `u-${id}`, state, blockedChannels });

function make(opts: { members?: string[]; operators?: AssignableOperator[] | Error }) {
  const groupBy = jest.fn(async () => [] as unknown[]);
  const prisma = {
    forAccount: () => ({ conversation: { groupBy } }),
  } as unknown as PrismaService;

  const auth = {
    // Feature 031: these tests are about availability on a desk that IS a queue.
    listGroupMembers: jest.fn(async () => ({ userIds: opts.members ?? ['u-a', 'u-b'], routable: true })),
  } as unknown as AuthorAuthorityClient;

  const users = {
    resolveOperators: jest.fn(async () => {
      if (opts.operators instanceof Error) throw opts.operators;
      return opts.operators ?? [];
    }),
  } as unknown as PersonMembersClient;

  return { pool: new GroupPoolService(prisma, auth, users) };
}

describe('the candidate pool honours availability (feature 025)', () => {
  it('an ONLINE member is a candidate', async () => {
    const { pool } = make({ operators: [op('a')] });
    const { candidates: out } = await pool.candidatesFor('acc-1', 'grp-1', md);
    expect(out.map((c) => c.operatorId)).toEqual(['a']);
  });

  it.each(['away', 'offline'] as const)('an operator who is %s is NOT a candidate', async (state) => {
    const { pool } = make({ operators: [op('a', state)] });
    expect((await pool.candidatesFor('acc-1', 'grp-1', md)).candidates).toEqual([]);
  });

  it('⭐ `transfers_only` is NOT a candidate for a NEW PUSH', async () => {
    // The router hands out work nobody asked for; `transfers_only` says no to exactly that while
    // still accepting a handover from a human. This is the cell where the two asks disagree, and it
    // is the whole reason presence is a state rather than one of the editable labels.
    const { pool } = make({ operators: [op('a', 'transfers_only')] });
    expect((await pool.candidatesFor('acc-1', 'grp-1', md)).candidates).toEqual([]);
  });

  it('narrows the set rather than emptying it — the available members survive', async () => {
    const { pool } = make({ operators: [op('a'), op('b', 'away'), op('c')] });
    const { candidates: out } = await pool.candidatesFor('acc-1', 'grp-1', md);
    expect(out.map((c) => c.operatorId)).toEqual(['a', 'c']);
  });

  it('keeps the stable order the rotation cursor depends on', async () => {
    // Feature 013's fairness property is an INDEX into this list; an unstable order would point the
    // cursor at a different person between calls. The presence filter must not disturb it.
    const { pool } = make({ operators: [op('c'), op('a'), op('b')] });
    const { candidates: out } = await pool.candidatesFor('acc-1', 'grp-1', md);
    expect(out.map((c) => c.operatorId)).toEqual(['a', 'b', 'c']);
  });

  it('a desk where NOBODY is available yields an empty pool — a fact, not a failure', async () => {
    const { pool } = make({ operators: [op('a', 'away'), op('b', 'offline')] });
    expect((await pool.candidatesFor('acc-1', 'grp-1', md)).candidates).toEqual([]);
  });

  it('⭐ when availability cannot be established, the call RAISES', async () => {
    // Never an empty pool. The caller turns an empty pool into "nobody available", which would be a
    // lie here — the truth is that we do not know.
    const { pool } = make({ operators: new MembershipUnavailableError('users unreachable') });
    await expect(pool.candidatesFor('acc-1', 'grp-1', md)).rejects.toBeInstanceOf(
      MembershipUnavailableError,
    );
  });

  it('⭐ and it does NOT quietly assume everybody is available instead', async () => {
    // The other wrong default, asserted absent. If this ever starts passing by returning candidates,
    // routing is pushing live customers at people whose state nobody could read.
    const { pool } = make({ operators: new MembershipUnavailableError('users unreachable') });
    const result = await pool.candidatesFor('acc-1', 'grp-1', md).catch(() => 'raised' as const);
    expect(result).toBe('raised');
  });

  describe('per-channel switches (US3)', () => {
    it('absence of a switch means available for every channel', async () => {
      const { pool } = make({ operators: [op('a')] });
      expect((await pool.candidatesFor('acc-1', 'grp-1', md, 'live_chat')).candidates).toHaveLength(1);
    });

    it('a switched-off channel removes that operator for THAT channel only', async () => {
      const { pool } = make({ operators: [op('a', 'online', ['live_chat'])] });
      expect((await pool.candidatesFor('acc-1', 'grp-1', md, 'live_chat')).candidates).toEqual([]);
      expect((await pool.candidatesFor('acc-1', 'grp-1', md, 'email')).candidates).toHaveLength(1);
    });

    it('⭐ a conversation with NO channel recorded is answered at state level alone', async () => {
      // Feature 022 keeps "no channel recorded" distinct from every channel NAME. A null must never
      // be matched against a switch, or a switch on the empty string would silently apply to it.
      const { pool } = make({ operators: [op('a', 'online', ['', 'email'])] });
      expect((await pool.candidatesFor('acc-1', 'grp-1', md, null)).candidates).toHaveLength(1);
    });

    it('⭐ a switch can only SUBTRACT — it never rescues an unavailable operator', async () => {
      // The deliberate inversion of ADR 0039 (a group grants and never denies) stated as a test.
      const { pool } = make({ operators: [op('a', 'away', [])] });
      expect((await pool.candidatesFor('acc-1', 'grp-1', md, 'email')).candidates).toEqual([]);
    });
  });
});
