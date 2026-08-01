import { Metadata } from '@grpc/grpc-js';
import type { PrismaService } from '../src/prisma.service';
import { ContactSummaryRepository } from '../src/contact/contact-summary.repository';
import { ContactSummaryController } from '../src/contact/contact.grpc.controller';
import type { PersonMembersClient } from '../src/person/person-members.client';

const OURS = 'acc-1';
const THEIRS = 'acc-2';

function md(accountId: string): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'op-1');
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

/**
 * TWO ACCOUNTS, and the same `(brand_id, player_id)` in both — which is the case that matters. A
 * licensee's customer and ours can legitimately carry identical identifiers, so the ONLY thing keeping
 * them apart is `account_id` (SEC-17, Principle I: the sole tenancy wall since ADR 0038).
 */
const STORE: Conv[] = [
  {
    account_id: OURS,
    brand_id: 'brand-a',
    player_id: 'p1',
    status: 'open',
    channel: 'email',
    last_inbound_at: new Date('2026-07-20T09:00:00Z'),
    last_outbound_at: null,
  },
  {
    account_id: THEIRS,
    brand_id: 'brand-a',
    player_id: 'p1',
    status: 'open',
    channel: 'whatsapp',
    last_inbound_at: new Date('2026-07-28T09:00:00Z'),
    last_outbound_at: new Date('2026-07-28T10:00:00Z'),
  },
];

/** Reproduces the feature-007 extension: `account_id` is injected LAST, so a caller can only narrow. */
function fakePrisma() {
  const seen: string[] = [];
  const forAccount = jest.fn((accountId: string) => {
    seen.push(accountId);
    return {
      conversation: {
        groupBy: (args: { where: Record<string, unknown> }) => {
          const w: Record<string, unknown> = { ...args.where, account_id: accountId };
          let rows = STORE.filter((c) => c.account_id === w.account_id);
          if (w.brand_id) rows = rows.filter((c) => c.brand_id === w.brand_id);
          if (w.player_id) rows = rows.filter((c) => c.player_id === w.player_id);
          const or = w.OR as Array<{ brand_id: string; player_id: string }> | undefined;
          if (or)
            rows = rows.filter((c) =>
              or.some((m) => m.brand_id === c.brand_id && m.player_id === c.player_id),
            );
          const maxOf = (rs: Conv[], pick: (c: Conv) => Date | null) => {
            const t = rs.map(pick).filter((d): d is Date => !!d);
            return t.length ? new Date(Math.max(...t.map((d) => d.getTime()))) : null;
          };
          return Promise.resolve(
            rows.length === 0
              ? []
              : [
                  {
                    channel: rows[0]!.channel,
                    status: rows[0]!.status,
                    _count: { _all: rows.length },
                    _max: {
                      last_inbound_at: maxOf(rows, (c) => c.last_inbound_at),
                      last_outbound_at: maxOf(rows, (c) => c.last_outbound_at),
                    },
                  },
                ],
          );
        },
      },
    };
  });
  return { prisma: { forAccount } as unknown as PrismaService, forAccount, seen };
}

/** Throwing stub: the player-level read must never resolve person membership (see contact.spec.ts). */
const noMembers = () =>
  ({
    membersOf: () => {
      throw new Error('the player-level summary must not resolve person membership');
    },
  }) as unknown as PersonMembersClient;

const controller = (prisma: PrismaService) =>
  new ContactSummaryController(new ContactSummaryRepository(prisma), noMembers());

/**
 * Feature 022 (roadmap 4.13), T025 — **account isolation on the new read path** (Principle I / SEC-17).
 *
 * An aggregate is a new way to leak: it returns no rows, so nothing about it looks like a record, and a
 * missing `account_id` predicate would surface as a plausible timestamp rather than as someone else's
 * conversation. That is the failure this file exists to make impossible — and it is worth noting that a
 * leaked MAXIMUM is a real disclosure: "that customer spoke to someone on the 28th" is a fact about a
 * human in another tenant.
 */
describe('*** the contact summary cannot cross an account boundary ***', () => {
  it('returns OUR facts for the same (brand, player) that exists in both accounts', async () => {
    const { prisma } = fakePrisma();
    const res = await controller(prisma).getPlayerContactSummary(
      { playerId: 'p1', brandId: 'brand-a' },
      md(OURS),
    );
    expect(res.conversationCount).toBe(1);
    expect(res.lastInboundAt).toBe('2026-07-20T09:00:00.000Z');
    // The other tenant's later contact must be invisible — not merged, not compared, not "the maximum".
    expect(res.lastInboundAt).not.toBe('2026-07-28T09:00:00.000Z');
    expect(res.lastOutboundAt).toBe('');
    expect(res.channels.map((c) => c.channel)).toEqual(['email']);
  });

  it('scopes to the acting account and never to one taken from the request', async () => {
    const { prisma, forAccount } = fakePrisma();
    await controller(prisma).getPlayerContactSummary(
      { playerId: 'p1', brandId: 'brand-a' },
      md(OURS),
    );
    expect(forAccount).toHaveBeenCalledWith(OURS);
    expect(forAccount).not.toHaveBeenCalledWith(THEIRS);
  });

  it('an account with no such customer gets the never-contacted answer, not a refusal', async () => {
    // The two must be indistinguishable (SC-005): a refusal here would tell the caller that the record
    // exists somewhere, which is exactly what account isolation is meant to withhold.
    const { prisma } = fakePrisma();
    const absent = await controller(prisma).getPlayerContactSummary(
      { playerId: 'p-nobody', brandId: 'brand-a' },
      md(OURS),
    );
    const foreign = await controller(prisma).getPlayerContactSummary(
      { playerId: 'p1', brandId: 'brand-zzz' },
      md(OURS),
    );
    const never = {
      lastInboundAt: '',
      lastOutboundAt: '',
      lastContactAt: '',
      conversationCount: 0,
      countsByStatus: [],
      channels: [],
    };
    expect(absent).toEqual(never);
    expect(foreign).toEqual(never);
  });

  it('the member-set read is bounded by the same wall', async () => {
    // The person-level path takes an `OR` of member pairs. A member list is data from another service, so
    // the account predicate must still be the thing that decides — a hostile or stale member list may not
    // reach across a tenant.
    const { prisma } = fakePrisma();
    const groups = await new ContactSummaryRepository(prisma).groupsForMembers(OURS, [
      { brandId: 'brand-a', playerId: 'p1' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.conversationCount).toBe(1);
    expect(groups[0]!.lastInboundAt).toEqual(new Date('2026-07-20T09:00:00Z'));
  });

  it('an EMPTY member list queries nothing rather than everything', async () => {
    // `OR: []` matches nothing in Prisma today, but relying on that is one refactor away from returning
    // the whole account — so the repository short-circuits, and this pins it.
    const { prisma, forAccount } = fakePrisma();
    const groups = await new ContactSummaryRepository(prisma).groupsForMembers(OURS, []);
    expect(groups).toEqual([]);
    expect(forAccount).not.toHaveBeenCalled();
  });
});
