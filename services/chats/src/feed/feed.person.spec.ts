import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { ConversationRepository } from '../conversation/conversation.repository';
import { FeedReadController } from './feed.grpc.controller';
import {
  MembershipUnavailableError,
  type MemberIdentity,
  type PersonMembersClient,
} from '../person/person-members.client';
import { encodeCursor } from '../shared/cursor';
import { TransitionRecorder } from '../transition/transition.recorder';

function md(accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'op-1');
  m.set('x-actor-permissions', 'crm.inbox.view,crm.contact.view');
  return m;
}

interface Row {
  id: string;
  brand_id: string;
  player_id: string;
  created_at: Date;
}

function conv(id: string, brand: string, player: string, iso: string): Row {
  return { id, brand_id: brand, player_id: player, created_at: new Date(iso) };
}

/**
 * A fake that APPLIES the where — including the `OR` over member pairs and the keyset predicate — so the
 * tests prove the query rather than the fake. It also counts calls: "one query for all members" (FR-023)
 * is only assertable by counting.
 */
function fakePrisma(store: Row[]) {
  const findMany = jest.fn((args: Record<string, unknown>) => {
    const where = (args.where ?? {}) as Record<string, unknown>;
    let rows = [...store];

    const or = where.OR as Array<{ brand_id: string; player_id: string }> | undefined;
    if (or) {
      rows = rows.filter((r) =>
        or.some((m) => m.brand_id === r.brand_id && m.player_id === r.player_id),
      );
    }
    const idIn = (where.id as { in?: string[] } | undefined)?.in;
    if (idIn) rows = rows.filter((r) => idIn.includes(r.id));

    // The keyset predicate, applied so paging is genuinely exercised.
    const and = where.AND as Array<{ OR: Array<Record<string, unknown>> }> | undefined;
    if (and?.[0]) {
      const [ltClause, tieClause] = and[0].OR as [
        { created_at: { lt: Date } },
        { AND: [{ created_at: Date }, { id: { lt: string } }] },
      ];
      const at = ltClause.created_at.lt;
      const tieId = tieClause.AND[1].id.lt;
      rows = rows.filter(
        (r) =>
          r.created_at.getTime() < at.getTime() ||
          (r.created_at.getTime() === at.getTime() && r.id < tieId),
      );
    }

    rows.sort(
      (a, b) => b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : -1),
    );
    const take = args.take as number;
    return Promise.resolve(
      rows.slice(0, take).map((r) => ({
        ...r,
        status: 'open',
        priority: null,
        assignee_operator_id: null,
        channel: null,
        updated_at: r.created_at,
      })),
    );
  });
  const forAccount = jest.fn(() => ({ conversation: { findMany } }));
  return { prisma: { forAccount } as unknown as PrismaService, findMany };
}

function members(list: MemberIdentity[]) {
  const membersOf = jest.fn(async () => list);
  return { client: { membersOf } as unknown as PersonMembersClient, membersOf };
}

function failingMembers(err: unknown) {
  return {
    membersOf: () => Promise.reject(err),
  } as unknown as PersonMembersClient;
}

const ctrl = (prisma: PrismaService, m: PersonMembersClient) =>
  new FeedReadController(new ConversationRepository(prisma, new TransitionRecorder()), m);

/**
 * Feature 022 (roadmap 4.13), T042 — **`GetPersonFeed`, the rpc feature 020 declared and never served.**
 *
 * The question is different from the player feed's: "what has this PERSON written to us", across the
 * brands they were EXPLICITLY linked on. Membership comes from `users`; `chats` never derives a person and
 * never from a matching platform id — that merge was the 5.2 defect, and the last assertion in this file
 * is the one that says so.
 */
describe('GetPersonFeed — the conversations of one human', () => {
  const linked: MemberIdentity[] = [
    { brandId: 'brand-a', playerId: 'p1' },
    { brandId: 'brand-b', playerId: 'p2' },
  ];

  it('merges the linked members’ conversations into ONE chronological order', async () => {
    const { prisma } = fakePrisma([
      conv('c-a1', 'brand-a', 'p1', '2026-07-20T09:00:00Z'),
      conv('c-b1', 'brand-b', 'p2', '2026-07-22T09:00:00Z'),
      conv('c-a2', 'brand-a', 'p1', '2026-07-21T09:00:00Z'),
    ]);
    const res = await ctrl(prisma, members(linked).client).getPersonFeed(
      { personId: 'person-1' },
      md(),
    );
    expect(res.conversations.map((c) => c.id)).toEqual(['c-b1', 'c-a2', 'c-a1']);
  });

  it('every row still carries its OWN brand — the union never hides where a row came from', async () => {
    const { prisma } = fakePrisma([
      conv('c-a1', 'brand-a', 'p1', '2026-07-20T09:00:00Z'),
      conv('c-b1', 'brand-b', 'p2', '2026-07-22T09:00:00Z'),
    ]);
    const res = await ctrl(prisma, members(linked).client).getPersonFeed(
      { personId: 'person-1' },
      md(),
    );
    expect(res.conversations.map((c) => c.brandId).sort()).toEqual(['brand-a', 'brand-b']);
  });

  it('*** does NOT include a record sharing a platform id that is NOT linked (the 5.2 defect) ***', async () => {
    // The same `player_id` under a third brand, with no `PersonMember` row. Feature 020's whole point:
    // a cross-brand human is an explicit link, established on email or phone — never an id collision.
    const { prisma } = fakePrisma([
      conv('c-a1', 'brand-a', 'p1', '2026-07-20T09:00:00Z'),
      conv('c-c1', 'brand-c', 'p1', '2026-07-25T09:00:00Z'), // another human entirely
    ]);
    const res = await ctrl(prisma, members([{ brandId: 'brand-a', playerId: 'p1' }]).client)
      .getPersonFeed({ personId: 'person-1' }, md());
    expect(res.conversations.map((c) => c.id)).toEqual(['c-a1']);
  });

  it('issues ONE conversation query regardless of member count (FR-023)', async () => {
    const { prisma, findMany } = fakePrisma([
      conv('c-a1', 'brand-a', 'p1', '2026-07-20T09:00:00Z'),
      conv('c-b1', 'brand-b', 'p2', '2026-07-22T09:00:00Z'),
    ]);
    await ctrl(prisma, members(linked).client).getPersonFeed({ personId: 'person-1' }, md());
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('resolves membership ONCE, with the caller’s own metadata', async () => {
    const { prisma } = fakePrisma([]);
    const { client, membersOf } = members(linked);
    const metadata = md();
    await ctrl(prisma, client).getPersonFeed({ personId: 'person-1' }, metadata);
    expect(membersOf).toHaveBeenCalledTimes(1);
    expect(membersOf).toHaveBeenCalledWith('person-1', metadata);
  });

  it('a person with NO members gets an empty page — never the whole account', async () => {
    // The dangerous direction: an unfiltered query here would return every conversation in the tenant.
    const { prisma } = fakePrisma([conv('c-x', 'brand-a', 'p9', '2026-07-20T09:00:00Z')]);
    const res = await ctrl(prisma, members([]).client).getPersonFeed(
      { personId: 'person-1' },
      md(),
    );
    expect(res.conversations).toEqual([]);
    expect(res.nextPageToken).toBe('');
  });

  it('an empty personId is an empty feed, and asks users nothing', async () => {
    const { prisma, findMany } = fakePrisma([conv('c-x', 'brand-a', 'p1', '2026-07-20T09:00:00Z')]);
    const { client, membersOf } = members(linked);
    const res = await ctrl(prisma, client).getPersonFeed({ personId: '' }, md());
    expect(res.conversations).toEqual([]);
    expect(membersOf).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('FAILS when membership cannot be established — never a narrower answer', async () => {
    // FR-022. An aggregate over the members that happened to resolve is worse than an error: it is a
    // statement about a subset of a human wearing the shape of a statement about the human.
    const { prisma, findMany } = fakePrisma([conv('c-a1', 'brand-a', 'p1', '2026-07-20T09:00:00Z')]);
    await expect(
      ctrl(prisma, failingMembers(new MembershipUnavailableError('rpc failed'))).getPersonFeed(
        { personId: 'person-1' },
        md(),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(findMany).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **This assertion is about the STATUS, and the previous version was not — which is how the live run
   * came back with a 500.** It asserted the call rejected with the same object, and it passed; but a plain
   * error leaving a Nest gRPC handler becomes UNKNOWN, so a caller lacking `crm.contact.view` was told the
   * server had broken instead of being told no.
   */
  it('a REFUSAL from users keeps its status — PERMISSION_DENIED, so the edge answers 403', async () => {
    const denied = Object.assign(new Error('forbidden'), { code: GrpcStatus.PERMISSION_DENIED });
    const { prisma } = fakePrisma([]);
    try {
      await ctrl(prisma, failingMembers(denied)).getPersonFeed({ personId: 'person-1' }, md());
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcException);
      expect(((err as RpcException).getError() as { code: number }).code).toBe(
        GrpcStatus.PERMISSION_DENIED,
      );
    }
  });

  it('an UNAVAILABLE identity source stays distinguishable from a refusal', async () => {
    const { prisma } = fakePrisma([]);
    try {
      await ctrl(prisma, failingMembers(new MembershipUnavailableError('down'))).getPersonFeed(
        { personId: 'person-1' },
        md(),
      );
      throw new Error('should have failed');
    } catch (err) {
      expect(((err as RpcException).getError() as { code: number }).code).toBe(
        GrpcStatus.UNAVAILABLE,
      );
    }
  });

  it('refuses a malformed page token rather than silently returning page one', async () => {
    const { prisma } = fakePrisma([]);
    await expect(
      ctrl(prisma, members(linked).client).getPersonFeed(
        { personId: 'person-1', pageToken: 'not-a-cursor' },
        md(),
      ),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('refuses a caller with no account context (fail-closed)', async () => {
    const { prisma } = fakePrisma([]);
    await expect(
      ctrl(prisma, members(linked).client).getPersonFeed({ personId: 'person-1' }, new Metadata()),
    ).rejects.toBeInstanceOf(RpcException);
  });
});

/**
 * T042 (paging half, added by the analysis pass — FR-029 had no test).
 *
 * A page boundary between two DIFFERENT members' rows is exactly where a keyset over an `OR` predicate
 * goes wrong: the cursor is `(created_at, id)` for the whole union, not per member, and a per-member
 * implementation would repeat or skip rows here.
 */
describe('GetPersonFeed — keyset paging across the union', () => {
  const linked: MemberIdentity[] = [
    { brandId: 'brand-a', playerId: 'p1' },
    { brandId: 'brand-b', playerId: 'p2' },
  ];
  // Interleaved in time on purpose: b1, a2, b2, a1 by recency.
  const store = [
    conv('c-a1', 'brand-a', 'p1', '2026-07-19T09:00:00Z'),
    conv('c-b2', 'brand-b', 'p2', '2026-07-20T09:00:00Z'),
    conv('c-a2', 'brand-a', 'p1', '2026-07-21T09:00:00Z'),
    conv('c-b1', 'brand-b', 'p2', '2026-07-22T09:00:00Z'),
  ];

  it('walks the whole union with no repeats and no gaps at page size 1', async () => {
    const { prisma } = fakePrisma(store);
    const controller = ctrl(prisma, members(linked).client);
    const seen: string[] = [];
    let token = '';
    for (let i = 0; i < 5; i++) {
      const page = await controller.getPersonFeed(
        { personId: 'person-1', pageSize: 1, pageToken: token },
        md(),
      );
      seen.push(...page.conversations.map((c) => c.id));
      token = page.nextPageToken;
      if (!token) break;
    }
    expect(seen).toEqual(['c-b1', 'c-a2', 'c-b2', 'c-a1']);
    expect(new Set(seen).size).toBe(seen.length); // no repeats
    expect(token).toBe(''); // and the walk terminates
  });

  it('the cursor is for the UNION, so a boundary between two members’ rows is not special', async () => {
    const { prisma } = fakePrisma(store);
    const controller = ctrl(prisma, members(linked).client);
    // Start after the most recent row (a brand-b conversation); the next row belongs to brand-a.
    const after = encodeCursor({ createdAt: '2026-07-22T09:00:00.000Z', id: 'c-b1' });
    const page = await controller.getPersonFeed(
      { personId: 'person-1', pageSize: 2, pageToken: after },
      md(),
    );
    expect(page.conversations.map((c) => c.id)).toEqual(['c-a2', 'c-b2']);
  });

  it('caps the page size like every other list (Principle VII)', async () => {
    const { prisma, findMany } = fakePrisma(store);
    await ctrl(prisma, members(linked).client).getPersonFeed(
      { personId: 'person-1', pageSize: 100_000 },
      md(),
    );
    const [args] = findMany.mock.calls[0] as [{ take: number }];
    expect(args.take).toBeLessThanOrEqual(101); // server cap + 1 for the cursor probe
  });
});

/**
 * T043 — `ThreadProjection` is INERT on both feeds, and pinned so it cannot quietly acquire a meaning.
 *
 * A feed returns conversation SUMMARIES, which carry no message body — so there is nothing to project, and
 * the customer/staff distinction the field encodes (SEC-13) is enforced in the THREAD read, where bodies
 * exist. Leaving it unpinned is how a field on a payload with nothing to hide later starts changing
 * results.
 */
describe('T043 — the projection field changes nothing on either feed', () => {
  it('the person feed returns identical rows for staff and customer projections', async () => {
    const { prisma } = fakePrisma([
      conv('c-a1', 'brand-a', 'p1', '2026-07-20T09:00:00Z'),
      conv('c-b1', 'brand-b', 'p2', '2026-07-22T09:00:00Z'),
    ]);
    const linked = [
      { brandId: 'brand-a', playerId: 'p1' },
      { brandId: 'brand-b', playerId: 'p2' },
    ];
    const controller = ctrl(prisma, members(linked).client);
    const staff = await controller.getPersonFeed(
      { personId: 'person-1', projection: 'THREAD_PROJECTION_STAFF' },
      md(),
    );
    const customer = await controller.getPersonFeed(
      { personId: 'person-1', projection: 'THREAD_PROJECTION_CUSTOMER' },
      md(),
    );
    expect(customer).toEqual(staff);
  });

  it('the PLAYER feed does the same (the field predates this feature and stays inert)', async () => {
    const { prisma } = fakePrisma([conv('c-a1', 'brand-a', 'p1', '2026-07-20T09:00:00Z')]);
    const controller = ctrl(prisma, members([]).client);
    const staff = await controller.getPlayerFeed(
      { playerId: 'p1', brandId: 'brand-a', projection: 'THREAD_PROJECTION_STAFF' },
      md(),
    );
    const customer = await controller.getPlayerFeed(
      { playerId: 'p1', brandId: 'brand-a', projection: 'THREAD_PROJECTION_CUSTOMER' },
      md(),
    );
    expect(customer).toEqual(staff);
  });
});
