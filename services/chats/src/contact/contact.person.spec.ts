import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { ContactSummaryRepository } from './contact-summary.repository';
import { ContactSummaryController } from './contact.grpc.controller';
import {
  MembershipUnavailableError,
  type MemberIdentity,
  type PersonMembersClient,
} from '../person/person-members.client';

function md(accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'op-1');
  m.set('x-actor-permissions', 'crm.inbox.view,crm.contact.view');
  return m;
}

interface Conv {
  account_id: string;
  brand_id: string;
  player_id: string;
  status: string;
  channel: string | null;
  last_inbound_at: Date | null;
  last_outbound_at: Date | null;
}

function conv(over: Partial<Conv> = {}): Conv {
  return {
    account_id: 'acc-1',
    brand_id: 'brand-a',
    player_id: 'p1',
    status: 'open',
    channel: 'email',
    last_inbound_at: null,
    last_outbound_at: null,
    ...over,
  };
}

/** Groups for real, applies the `OR`, and counts calls — see contact.spec.ts for the reasoning. */
function fakePrisma(store: Conv[]) {
  const groupBy = jest.fn((args: { where: Record<string, unknown> }) => {
    const w = args.where;
    let rows = store.filter((c) => c.account_id === w.account_id);
    const or = w.OR as Array<{ brand_id: string; player_id: string }> | undefined;
    if (or)
      rows = rows.filter((c) =>
        or.some((m) => m.brand_id === c.brand_id && m.player_id === c.player_id),
      );
    if (w.brand_id) rows = rows.filter((c) => c.brand_id === w.brand_id);
    if (w.player_id) rows = rows.filter((c) => c.player_id === w.player_id);

    const groups = new Map<string, { channel: string | null; status: string; rows: Conv[] }>();
    for (const r of rows) {
      const key = `${r.channel ?? ' null'}|${r.status}`;
      const g = groups.get(key) ?? { channel: r.channel, status: r.status, rows: [] };
      g.rows.push(r);
      groups.set(key, g);
    }
    const maxOf = (rs: Conv[], pick: (c: Conv) => Date | null) => {
      const t = rs.map(pick).filter((d): d is Date => !!d);
      return t.length ? new Date(Math.max(...t.map((d) => d.getTime()))) : null;
    };
    return Promise.resolve(
      [...groups.values()].map((g) => ({
        channel: g.channel,
        status: g.status,
        _count: { _all: g.rows.length },
        _max: {
          last_inbound_at: maxOf(g.rows, (c) => c.last_inbound_at),
          last_outbound_at: maxOf(g.rows, (c) => c.last_outbound_at),
        },
      })),
    );
  });
  const forAccount = jest.fn((accountId: string) => ({
    conversation: {
      groupBy: (args: { where: Record<string, unknown> }) =>
        groupBy({ ...args, where: { ...args.where, account_id: accountId } }),
    },
  }));
  return { prisma: { forAccount } as unknown as PrismaService, groupBy, forAccount };
}

function members(list: MemberIdentity[]) {
  const membersOf = jest.fn(async () => list);
  return { client: { membersOf } as unknown as PersonMembersClient, membersOf };
}

const ctrl = (prisma: PrismaService, m: PersonMembersClient) =>
  new ContactSummaryController(new ContactSummaryRepository(prisma), m);

const LINKED: MemberIdentity[] = [
  { brandId: 'brand-a', playerId: 'p1' },
  { brandId: 'brand-b', playerId: 'p2' },
];

/**
 * Feature 022 (roadmap 4.13), T042 — **`GetPersonContactSummary`: the same facts, for one human.**
 *
 * ADR 0032 §1 promised the card ONE view of a customer across brands. Feature 020 narrowed how that is
 * established — an explicit link on email or phone, never an id match — and then nothing consumed it. This
 * is the consumer.
 */
describe('GetPersonContactSummary — the facts across a person’s linked records', () => {
  it('reports the LATER contact across brands, and counts both records', async () => {
    const { prisma } = fakePrisma([
      conv({ brand_id: 'brand-a', player_id: 'p1', last_inbound_at: new Date('2026-07-20T09:00:00Z') }),
      conv({ brand_id: 'brand-b', player_id: 'p2', last_inbound_at: new Date('2026-07-22T09:00:00Z') }),
    ]);
    const res = await ctrl(prisma, members(LINKED).client).getPersonContactSummary(
      { personId: 'person-1' },
      md(),
    );
    expect(res.lastInboundAt).toBe('2026-07-22T09:00:00.000Z');
    expect(res.lastContactAt).toBe('2026-07-22T09:00:00.000Z');
    expect(res.conversationCount).toBe(2);
  });

  it('attributes each channel to the brand it came from, in one rollup', async () => {
    const { prisma } = fakePrisma([
      conv({
        brand_id: 'brand-a',
        player_id: 'p1',
        channel: 'whatsapp',
        last_inbound_at: new Date('2026-07-22T09:00:00Z'),
      }),
      conv({
        brand_id: 'brand-b',
        player_id: 'p2',
        channel: 'email',
        last_outbound_at: new Date('2026-07-21T09:00:00Z'),
      }),
    ]);
    const res = await ctrl(prisma, members(LINKED).client).getPersonContactSummary(
      { personId: 'person-1' },
      md(),
    );
    expect(res.channels.map((c) => c.channel)).toEqual(['email', 'whatsapp']);
    const wa = res.channels.find((c) => c.channel === 'whatsapp')!;
    expect(wa.lastInboundAt).toBe('2026-07-22T09:00:00.000Z');
    expect(wa.lastOutboundAt).toBe('');
  });

  it('*** an UNLINKED record sharing a platform id never appears (the 5.2 defect at aggregate level) ***', async () => {
    const { prisma } = fakePrisma([
      conv({ brand_id: 'brand-a', player_id: 'p1', last_inbound_at: new Date('2026-07-20T09:00:00Z') }),
      // Another human: same platform id, third brand, no link.
      conv({ brand_id: 'brand-c', player_id: 'p1', last_inbound_at: new Date('2026-07-28T09:00:00Z') }),
    ]);
    const res = await ctrl(prisma, members([{ brandId: 'brand-a', playerId: 'p1' }]).client)
      .getPersonContactSummary({ personId: 'person-1' }, md());
    expect(res.conversationCount).toBe(1);
    expect(res.lastInboundAt).toBe('2026-07-20T09:00:00.000Z');
  });

  it('issues ONE grouped query regardless of member count (FR-023 / SC-012)', async () => {
    const { prisma, groupBy } = fakePrisma([
      conv({ brand_id: 'brand-a', player_id: 'p1' }),
      conv({ brand_id: 'brand-b', player_id: 'p2' }),
    ]);
    await ctrl(prisma, members(LINKED).client).getPersonContactSummary(
      { personId: 'person-1' },
      md(),
    );
    expect(groupBy).toHaveBeenCalledTimes(1);
  });

  it('resolves membership once, with the caller’s own metadata (users enforces crm.contact.view)', async () => {
    const { prisma } = fakePrisma([]);
    const { client, membersOf } = members(LINKED);
    const metadata = md();
    await ctrl(prisma, client).getPersonContactSummary({ personId: 'person-1' }, metadata);
    expect(membersOf).toHaveBeenCalledTimes(1);
    expect(membersOf).toHaveBeenCalledWith('person-1', metadata);
  });

  it('a person with ONE member equals that member’s own summary', async () => {
    // A person of one is a legitimate state: 020 links on the second matching record, and an unlink can
    // leave one behind.
    const store = [
      conv({ brand_id: 'brand-a', player_id: 'p1', last_inbound_at: new Date('2026-07-20T09:00:00Z') }),
    ];
    const single = [{ brandId: 'brand-a', playerId: 'p1' }];
    const person = await ctrl(fakePrisma(store).prisma, members(single).client)
      .getPersonContactSummary({ personId: 'person-1' }, md());
    const player = await ctrl(fakePrisma(store).prisma, members([]).client)
      .getPlayerContactSummary({ playerId: 'p1', brandId: 'brand-a' }, md());
    expect(person).toEqual(player);
  });

  it('a person with NO members is NEVER CONTACTED — not an error, and not the whole account', async () => {
    // An empty membership is a data state; an unreadable one is a failure (the next test). Answering both
    // the same way is exactly what FR-022 forbids.
    const { prisma, groupBy } = fakePrisma([conv({ brand_id: 'brand-z', player_id: 'p9' })]);
    const res = await ctrl(prisma, members([]).client).getPersonContactSummary(
      { personId: 'person-1' },
      md(),
    );
    expect(res.conversationCount).toBe(0);
    expect(res.lastContactAt).toBe('');
    // …and it does not even query, so an unfiltered read cannot happen by accident.
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('FAILS when membership is unavailable — never an aggregate over the members that resolved', async () => {
    const { prisma, groupBy } = fakePrisma([conv()]);
    const failing = {
      membersOf: () => Promise.reject(new MembershipUnavailableError('rpc failed')),
    } as unknown as PersonMembersClient;
    await expect(
      ctrl(prisma, failing).getPersonContactSummary({ personId: 'person-1' }, md()),
    ).rejects.toBeInstanceOf(RpcException);
    // The load-bearing half: it does not fall back to querying anyway.
    expect(groupBy).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ **This test used to assert `rejects.toBe(denied)` — and that is why the live run found a 500.**
   *
   * The call did reject, so the old assertion passed. But a plain error leaving a Nest gRPC handler becomes
   * **UNKNOWN**, which the gateway correctly maps to 500 — so a caller who merely lacked `crm.contact.view`
   * was told the server had broken. What matters is not that it rejected; it is **which status the service
   * emits**, because that is the only part the caller ever sees.
   */
  it('a refusal from users surfaces with ITS OWN status — PERMISSION_DENIED, not UNKNOWN', async () => {
    const denied = Object.assign(new Error('forbidden'), { code: GrpcStatus.PERMISSION_DENIED });
    const { prisma } = fakePrisma([]);
    const refusing = { membersOf: () => Promise.reject(denied) } as unknown as PersonMembersClient;
    try {
      await ctrl(prisma, refusing).getPersonContactSummary({ personId: 'person-1' }, md());
      throw new Error('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcException);
      const e = (err as RpcException).getError() as { code: number; message: string };
      expect(e.code).toBe(GrpcStatus.PERMISSION_DENIED);
      // And the message carries nothing from downstream (SEC-26).
      expect(e.message).toBe('forbidden');
      expect(e.message).not.toContain('person-1');
    }
  });

  it('an UNAVAILABLE identity source surfaces as UNAVAILABLE, distinguishably from a refusal', async () => {
    // The two must not collapse into one status: "you may not ask this" is the caller's to fix and "the
    // source is down" is not.
    const { prisma } = fakePrisma([]);
    const failing = {
      membersOf: () => Promise.reject(new MembershipUnavailableError('rpc failed')),
    } as unknown as PersonMembersClient;
    try {
      await ctrl(prisma, failing).getPersonContactSummary({ personId: 'person-1' }, md());
      throw new Error('should have failed');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcException);
      expect(((err as RpcException).getError() as { code: number }).code).toBe(
        GrpcStatus.UNAVAILABLE,
      );
    }
  });

  it('an empty personId is the never-contacted answer and asks users nothing', async () => {
    const { prisma, groupBy } = fakePrisma([conv()]);
    const { client, membersOf } = members(LINKED);
    const res = await ctrl(prisma, client).getPersonContactSummary({ personId: '' }, md());
    expect(res.conversationCount).toBe(0);
    expect(membersOf).not.toHaveBeenCalled();
    expect(groupBy).not.toHaveBeenCalled();
  });

  it('cannot cross an account boundary, even with a member list naming another tenant’s record', async () => {
    // A member list is data from another service. The account predicate — not the list — is what decides.
    const { prisma } = fakePrisma([
      conv({ account_id: 'acc-2', brand_id: 'brand-a', player_id: 'p1', last_inbound_at: new Date() }),
    ]);
    const res = await ctrl(prisma, members([{ brandId: 'brand-a', playerId: 'p1' }]).client)
      .getPersonContactSummary({ personId: 'person-1' }, md('acc-1'));
    expect(res.conversationCount).toBe(0);
  });

  it('uses the SAME fold as the player level (identical shape, no second implementation)', async () => {
    const { prisma } = fakePrisma([
      conv({ brand_id: 'brand-a', player_id: 'p1', last_inbound_at: new Date('2026-07-20T09:00:00Z') }),
    ]);
    const res = await ctrl(prisma, members([{ brandId: 'brand-a', playerId: 'p1' }]).client)
      .getPersonContactSummary({ personId: 'person-1' }, md());
    expect(Object.keys(res).sort()).toEqual([
      'channels',
      'conversationCount',
      'countsByStatus',
      'lastContactAt',
      'lastInboundAt',
      'lastOutboundAt',
    ]);
  });
});
