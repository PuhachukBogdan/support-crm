import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { SEEDED_STATUSES } from '@crm/common';
import type { PrismaService } from '../prisma.service';
import { StatusRepository, toStatusDefWire } from './status.repository';
import { StatusReadController } from './status.grpc.controller';
import { resolveStatusFilter, StatusFilterError } from './status-filter';
import { ConversationRepository } from '../conversation/conversation.repository';
import { ConversationReadController } from '../conversation/conversation.grpc.controller';
import { ConversationWriteController } from '../conversation/conversation.write.controller';
import { TransitionRecorder } from '../transition/transition.recorder';
import type { SlaRepository } from '../sla/sla.repository';
import type { PersonMembersClient } from '../person/person-members.client';
import type { DomainEventPublisher } from '../events/events.publisher';

/**
 * T019 / T020 / T023 (feature 032, roadmap 4.16 — ADR 0040) — the status catalogue end to end.
 *
 * ⚠️ **Two accounts everywhere.** A per-account vocabulary is a new way to ask a question across a tenant
 * boundary, so every case that resolves a key does it with a second account present whose statuses differ.
 * Principle I is the one wall this product has left (ADR 0038 §1), and a new lookup that ignores it would
 * look exactly like a working feature.
 */

const A = 'acc-a';
const B = 'acc-b';

/** Account A has the seeded nine; account B has ONE status, with a key A does not have. */
const ROWS: Record<string, Array<Record<string, unknown>>> = {
  [A]: SEEDED_STATUSES.map((s, i) => ({
    key: s.key,
    category: s.category,
    agent_name: s.agentName,
    end_user_name: s.endUserName,
    // One RETIRED status, so "not settable but still filterable" is a real case rather than a comment.
    active: s.key !== 'auto_ended_chat',
    order: s.order,
    _i: i,
  })),
  [B]: [
    {
      key: 'b_only',
      category: 'open',
      agent_name: 'B only',
      end_user_name: 'Open',
      active: true,
      order: 10,
    },
  ],
};

function fakePrisma(conversationRows: Array<Record<string, unknown>> = []) {
  const findMany = jest.fn();
  const forAccount = jest.fn((accountId: string) => {
    const rows = ROWS[accountId] ?? [];
    return {
      conversationStatus: {
        findMany: async (args?: {
          where?: { category?: unknown; active?: unknown };
          orderBy?: unknown;
        }) => {
          const w = args?.where ?? {};
          return rows.filter((r) => {
            if (w.active === true && r.active !== true) return false;
            const cat = w.category as { in?: string[] } | string | undefined;
            if (typeof cat === 'string') return r.category === cat;
            if (cat && Array.isArray(cat.in)) return cat.in.includes(r.category as string);
            return true;
          });
        },
        findFirst: async (args?: { where?: { key?: string; active?: boolean } }) => {
          const w = args?.where ?? {};
          return (
            rows.find(
              (r) => r.key === w.key && (w.active === undefined || r.active === w.active),
            ) ?? null
          );
        },
      },
      conversation: {
        findMany: findMany.mockImplementation(async () => conversationRows),
        findFirst: async () => conversationRows[0] ?? null,
        updateMany: async () => ({ count: 1 }),
      },
      conversationTransition: { create: async () => ({}) },
      $transaction: async (fn: unknown) => {
        if (typeof fn === 'function') {
          return (fn as (tx: unknown) => Promise<unknown>)(forAccount(accountId));
        }
        return [];
      },
    };
  });
  return { prisma: { forAccount } as unknown as PrismaService, forAccount, findMany };
}

const md = (accountId: string): Metadata => {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
  m.set('x-actor-permissions', 'crm.inbox.view,crm.conversation.reply');
  return m;
};

const repoOf = (prisma: PrismaService) => new StatusRepository(prisma);

// ── The catalogue read ───────────────────────────────────────────────────────────────────────────

describe('ListConversationStatuses — the vocabulary a screen labels the list with', () => {
  it('returns the account’s statuses with both names, the category and the order', async () => {
    const { prisma } = fakePrisma();
    const ctrl = new StatusReadController(repoOf(prisma));
    const res = (await ctrl.listConversationStatuses({}, md(A))) as {
      statuses: Array<Record<string, unknown>>;
    };

    expect(res.statuses).toHaveLength(9);
    expect(res.statuses[0]).toEqual({
      key: 'new',
      category: 'CONVERSATION_STATUS_CATEGORY_NEW',
      agentName: 'New',
      endUserName: 'Open',
      active: true,
      order: 10,
    });
  });

  it('⚠️ INCLUDES a retired status — an old ticket still wearing it must still render a label', async () => {
    const { prisma } = fakePrisma();
    const ctrl = new StatusReadController(repoOf(prisma));
    const res = (await ctrl.listConversationStatuses({}, md(A))) as {
      statuses: Array<{ key: string; active: boolean }>;
    };
    expect(res.statuses.find((s) => s.key === 'auto_ended_chat')).toMatchObject({ active: false });
  });

  it('⭐ tenant isolation: account B sees ONLY its own status, and A never sees B’s', async () => {
    const { prisma, forAccount } = fakePrisma();
    const ctrl = new StatusReadController(repoOf(prisma));

    const forB = (await ctrl.listConversationStatuses({}, md(B))) as {
      statuses: Array<{ key: string }>;
    };
    expect(forB.statuses.map((s) => s.key)).toEqual(['b_only']);
    expect(forAccount).toHaveBeenCalledWith(B);

    const forA = (await ctrl.listConversationStatuses({}, md(A))) as {
      statuses: Array<{ key: string }>;
    };
    expect(forA.statuses.map((s) => s.key)).not.toContain('b_only');
  });

  it('fails closed with no account context — a catalogue is tenant data like any other', async () => {
    const { prisma } = fakePrisma();
    const ctrl = new StatusReadController(repoOf(prisma));
    await expect(ctrl.listConversationStatuses({}, new Metadata())).rejects.toBeInstanceOf(
      RpcException,
    );
  });

  it('the wire mapper never invents a category for a stored value outside the catalogue', () => {
    expect(
      toStatusDefWire({
        key: 'x',
        category: 'nonsense',
        agent_name: 'X',
        end_user_name: 'X',
        active: true,
        order: 1,
      }).category,
    ).toBe('CONVERSATION_STATUS_CATEGORY_UNSPECIFIED');
  });
});

// ── Resolution for writes ────────────────────────────────────────────────────────────────────────

describe('resolveActive / activeKeys / nonTerminalKeys', () => {
  it('resolves a settable key, and refuses a RETIRED one exactly as it refuses an unknown one', async () => {
    const { prisma } = fakePrisma();
    const repo = repoOf(prisma);
    await expect(repo.resolveActive(A, 'vip_pending')).resolves.toMatchObject({
      key: 'vip_pending',
    });
    // Retired and unknown are the SAME answer: "may I still set Follow-up?" must not depend on the caller.
    expect(await repo.resolveActive(A, 'auto_ended_chat')).toBeNull();
    expect(await repo.resolveActive(A, 'closed')).toBeNull();
    expect(await repo.resolveActive(A, '')).toBeNull();
  });

  it('⭐ another account’s key does not resolve — isolation, not a missing row', async () => {
    const { prisma } = fakePrisma();
    const repo = repoOf(prisma);
    expect(await repo.resolveActive(A, 'b_only')).toBeNull();
    await expect(repo.resolveActive(B, 'b_only')).resolves.toMatchObject({ key: 'b_only' });
    // …and the reverse: A's ordinary status is invisible from B.
    expect(await repo.resolveActive(B, 'open')).toBeNull();
  });

  it('activeKeys omits the retired one; existsKey still finds it', async () => {
    const { prisma } = fakePrisma();
    const repo = repoOf(prisma);
    expect(await repo.activeKeys(A)).not.toContain('auto_ended_chat');
    expect(await repo.existsKey(A, 'auto_ended_chat')).toBe(true);
    expect(await repo.existsKey(A, 'b_only')).toBe(false);
  });

  it('⭐ nonTerminalKeys counts ON_HOLD work — the load bug the old two-word list had', async () => {
    const { prisma } = fakePrisma();
    const keys = await repoOf(prisma).nonTerminalKeys(A);
    for (const held of ['in_progress', 'vip_pending', 'follow_up', 'supervisor_review']) {
      expect(keys).toContain(held);
    }
    expect(keys).not.toContain('solved');
  });
});

// ── The filter ───────────────────────────────────────────────────────────────────────────────────

describe('the status filter, decoded once for the list and the export', () => {
  const filter = async (accountId: string, f: Record<string, string>) =>
    resolveStatusFilter(repoOf(fakePrisma().prisma), accountId, f);

  it('no status filter at all ⇒ undefined (every status), not an empty set', async () => {
    await expect(filter(A, {})).resolves.toBeUndefined();
    await expect(
      filter(A, { statusCategory: 'CONVERSATION_STATUS_CATEGORY_UNSPECIFIED' }),
    ).resolves.toBeUndefined();
  });

  it('an exact key resolves to itself — including a RETIRED one (still filterable)', async () => {
    await expect(filter(A, { statusKey: 'vip_pending' })).resolves.toEqual(['vip_pending']);
    await expect(filter(A, { statusKey: 'auto_ended_chat' })).resolves.toEqual(['auto_ended_chat']);
  });

  it('a category resolves to that account’s keys in it', async () => {
    await expect(filter(A, { statusCategory: 'CONVERSATION_STATUS_CATEGORY_PENDING' })).resolves.toEqual(
      ['pending', 'vip_pending'],
    );
  });

  it('⚠️ a category with no configured status yields [] — an EMPTY page, never an unfiltered one', async () => {
    await expect(filter(A, { statusCategory: 'CONVERSATION_STATUS_CATEGORY_CLOSED' })).resolves.toEqual(
      [],
    );
  });

  it('key AND category = the intersection; a contradictory pair yields []', async () => {
    await expect(
      filter(A, {
        statusKey: 'vip_pending',
        statusCategory: 'CONVERSATION_STATUS_CATEGORY_PENDING',
      }),
    ).resolves.toEqual(['vip_pending']);
    await expect(
      filter(A, { statusKey: 'vip_pending', statusCategory: 'CONVERSATION_STATUS_CATEGORY_SOLVED' }),
    ).resolves.toEqual([]);
  });

  it('⭐ the LEGACY enum filter is REFUSED, not mapped — a lossy filter is a wrong answer', async () => {
    await expect(filter(A, { status: 'CONVERSATION_STATUS_SNOOZED' })).rejects.toBeInstanceOf(
      StatusFilterError,
    );
    await expect(filter(A, { status: 'CONVERSATION_STATUS_OPEN' })).rejects.toBeInstanceOf(
      StatusFilterError,
    );
    // UNSPECIFIED is not a legacy ASK — it is the absence of one, and must pass through.
    await expect(filter(A, { status: 'CONVERSATION_STATUS_UNSPECIFIED' })).resolves.toBeUndefined();
  });

  it('an unknown key and an unknown category are both refused rather than ignored', async () => {
    await expect(filter(A, { statusKey: 'nonsense' })).rejects.toBeInstanceOf(StatusFilterError);
    await expect(filter(A, { statusCategory: 'CONVERSATION_STATUS_CATEGORY_SNOOZED' })).rejects.toBeInstanceOf(
      StatusFilterError,
    );
  });

  it('⭐ another account’s key is refused — the filter cannot reach across the boundary', async () => {
    await expect(filter(A, { statusKey: 'b_only' })).rejects.toBeInstanceOf(StatusFilterError);
    await expect(filter(B, { statusKey: 'b_only' })).resolves.toEqual(['b_only']);
  });
});

// ── Through the list controller ──────────────────────────────────────────────────────────────────

const noSla = () =>
  ({
    conversationIdsByOutcome: jest.fn(async () => []),
    getState: jest.fn(async () => null),
  }) as unknown as SlaRepository;
const noPortfolio = () =>
  ({ attachedPlayersOfCaller: jest.fn(async () => []) }) as unknown as PersonMembersClient;

const CONV = {
  id: 'c1',
  brand_id: 'brand-a',
  player_id: 'p1',
  status: 'in_progress',
  status_def: { category: 'on_hold' },
  priority: 'normal',
  assignee_operator_id: 'op-1',
  channel: 'api',
  created_at: new Date('2026-08-04T10:00:00.000Z'),
  updated_at: new Date('2026-08-04T10:00:00.000Z'),
  subject: 'Promo code not applying at checkout',
  priority_rank: 2,
};

describe('ListConversations — the two new filters, and what the row now carries', () => {
  const build = (prisma: PrismaService) =>
    new ConversationReadController(
      new ConversationRepository(prisma, new TransitionRecorder()),
      noSla(),
      noPortfolio(),
      repoOf(prisma),
    );

  it('⭐ the row carries the KEY and the CATEGORY, and no longer the retired enum', async () => {
    const { prisma } = fakePrisma([CONV]);
    const res = await build(prisma).listConversations({}, md(A));
    expect(res.conversations[0]).toMatchObject({
      statusKey: 'in_progress',
      statusCategory: 'CONVERSATION_STATUS_CATEGORY_ON_HOLD',
    });
    expect(res.conversations[0]).not.toHaveProperty('status');
  });

  it('a category filter becomes ONE query with the account’s keys — not a second endpoint', async () => {
    const { prisma, findMany } = fakePrisma([CONV]);
    await build(prisma).listConversations(
      { statusCategory: 'CONVERSATION_STATUS_CATEGORY_PENDING' },
      md(A),
    );
    expect(findMany.mock.calls[0][0].where.status).toEqual({ in: ['pending', 'vip_pending'] });
  });

  it('⭐ isolation: the same category filter under account B resolves to B’s keys only', async () => {
    const { prisma, findMany, forAccount } = fakePrisma([]);
    await build(prisma).listConversations(
      { statusCategory: 'CONVERSATION_STATUS_CATEGORY_OPEN' },
      md(B),
    );
    expect(forAccount).toHaveBeenCalledWith(B);
    expect(findMany.mock.calls[0][0].where.status).toEqual({ in: ['b_only'] });
    // …and the caller cannot smuggle an account into the query itself.
    expect(findMany.mock.calls[0][0].where.account_id).toBeUndefined();
  });

  it('an unknown key is a refusal, and the list is never read', async () => {
    const { prisma, findMany } = fakePrisma([CONV]);
    await expect(
      build(prisma).listConversations({ statusKey: 'nonsense' }, md(A)),
    ).rejects.toBeInstanceOf(RpcException);
    expect(findMany).not.toHaveBeenCalled();
  });
});

// ── Through the write controller ─────────────────────────────────────────────────────────────────

describe('SetConversationStatus — nine settable words instead of four', () => {
  const noEvents = () =>
    ({
      conversationCreated: jest.fn(async () => 0),
      statusChanged: jest.fn(async () => 0),
    }) as unknown as DomainEventPublisher;
  const noAudit = () =>
    ({
      statement: () => {
        throw new Error('a status change is not an audited act (feature 032)');
      },
    }) as never;

  const build = (prisma: PrismaService) =>
    new ConversationWriteController(
      new ConversationRepository(prisma, new TransitionRecorder()),
      noEvents(),
      repoOf(prisma),
      noAudit(),
    );

  it('⭐ accepts a status the flat enum could not express', async () => {
    const { prisma } = fakePrisma([CONV]);
    const res = await build(prisma).setConversationStatus(
      { conversationId: 'c1', statusKey: 'supervisor_review' },
      md(A),
    );
    expect(res.statusKey).toBe('in_progress'); // the fake re-reads the same row; the WRITE is what matters
    expect(res.statusCategory).toBe('CONVERSATION_STATUS_CATEGORY_ON_HOLD');
  });

  it.each([
    ['an unknown key', 'nonsense'],
    ['a RETIRED key', 'auto_ended_chat'],
    ['a CATEGORY mistaken for a status', 'closed'],
    ['another account’s key', 'b_only'],
    ['nothing at all', ''],
  ])('refuses %s', async (_label, statusKey) => {
    const { prisma } = fakePrisma([CONV]);
    await expect(
      build(prisma).setConversationStatus({ conversationId: 'c1', statusKey }, md(A)),
    ).rejects.toBeInstanceOf(RpcException);
  });

  it('⚠️ refuses a caller that sends ONLY the retired enum field rather than guessing', async () => {
    const { prisma } = fakePrisma([CONV]);
    await expect(
      build(prisma).setConversationStatus(
        { conversationId: 'c1', status: 'CONVERSATION_STATUS_PENDING' },
        md(A),
      ),
    ).rejects.toBeInstanceOf(RpcException);
  });
});
