import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { SlaSweepRepository } from './sla-sweep.repository';
import { SlaMaintenanceController } from './sla.grpc.controller';
import type { PrismaService } from '../prisma.service';
import type { SlaRepository } from './sla.repository';
import type { DomainEventPublisher } from '../events/events.publisher';

/**
 * T033 (feature 014, US2) — **the fences around the one unscoped tenant read** (research R3).
 *
 * This is the single Principle-I-relevant change in the feature, logged in the plan's Complexity
 * Tracking. It is justified by five properties, so each one gets an assertion rather than a promise:
 *
 *   1. ids only — the `select` carries no content;
 *   2. counts only leave the service — the RPC returns no ids;
 *   3. system callers only — a user actor is refused;
 *   4. no gateway route (asserted in `gateway/src/chats/no-maintenance-route.spec.ts`);
 *   5. bounded — the batch is capped;
 *   plus: every write that follows goes through `forAccount`.
 *
 * If a future change breaks any of them, this file is where it should fail.
 */
const NOW = new Date('2026-07-27T12:00:00.000Z');

function fakeBase(rows: { account_id: string; conversation_id: string }[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  // NOTE the shape: the sweep uses the BASE client (`this.prisma.conversationSlaState`), not
  // `forAccount(...)`. A `forAccount` here would blow up — which is itself the point.
  const forAccount = jest.fn(() => {
    throw new Error('the sweep read must not go through forAccount');
  });
  return { prisma: { conversationSlaState: { findMany }, forAccount } as unknown as PrismaService, findMany };
}

describe('findDueConversationIds — fence 1: IDS ONLY', () => {
  it('selects exactly account_id + conversation_id and nothing else', async () => {
    const { prisma, findMany } = fakeBase();
    await new SlaSweepRepository(prisma).findDueConversationIds(100, NOW);
    const args = findMany.mock.calls[0]![0] as { select: Record<string, boolean> };
    expect(Object.keys(args.select).sort()).toEqual(['account_id', 'conversation_id']);
  });

  it('never selects anything resembling content or PII', async () => {
    const { prisma, findMany } = fakeBase();
    await new SlaSweepRepository(prisma).findDueConversationIds(100, NOW);
    const select = (findMany.mock.calls[0]![0] as { select: Record<string, boolean> }).select;
    for (const forbidden of [
      'body',
      'player_id',
      'assignee_operator_id',
      'status',
      'priority',
      'first_reply_at',
      'target_minutes',
    ]) {
      expect(select[forbidden]).toBeUndefined();
    }
  });
});

describe('findDueConversationIds — fence 5: BOUNDED, and the right predicate', () => {
  it('filters on running + not-yet-announced + deadline passed', async () => {
    const { prisma, findMany } = fakeBase();
    await new SlaSweepRepository(prisma).findDueConversationIds(10, NOW);
    expect((findMany.mock.calls[0]![0] as { where: unknown }).where).toEqual({
      outcome: 'running',
      breach_announced_at: null,
      deadline_at: { lte: NOW },
    });
  });

  it('orders oldest-deadline-first so a capped batch handles the worst breach first', async () => {
    const { prisma, findMany } = fakeBase();
    await new SlaSweepRepository(prisma).findDueConversationIds(10, NOW);
    expect((findMany.mock.calls[0]![0] as { orderBy: unknown }).orderBy).toEqual([
      { deadline_at: 'asc' },
    ]);
  });

  it.each([
    [10, 10],
    [0, 1],
    [-5, 1],
    [999_999, 5_000], // one tick can never scan the world
  ])('clamps a limit of %p to %p', async (given, expected) => {
    const { prisma, findMany } = fakeBase();
    await new SlaSweepRepository(prisma).findDueConversationIds(given, NOW);
    expect((findMany.mock.calls[0]![0] as { take: number }).take).toBe(expected);
  });
});

describe('findDueConversationIds — the file stays auditable in full', () => {
  // The value of this escape hatch is that it is exactly ONE method, small enough to read at a glance.
  // A second query here would need its own justification, so it should fail this test first.
  it('contains a single findMany and no other tenant query', () => {
    const src = readFileSync(join(__dirname, 'sla-sweep.repository.ts'), 'utf8');
    const queries = src.match(/this\.prisma\.[A-Za-z]+\.[a-zA-Z]+\(/g) ?? [];
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('findMany');
  });
});

describe('SweepFirstReplySla — fences 2, 3 and the scoped follow-up', () => {
  function build(
    due: { account_id: string; conversation_id: string }[],
    over: { marked?: boolean; ruleCount?: number } = {},
  ) {
    const markBreached = jest.fn().mockResolvedValue(over.marked ?? true);
    const firstReplyBreached = jest.fn().mockResolvedValue(over.ruleCount ?? 0);
    const sweep = { findDueConversationIds: jest.fn().mockResolvedValue(due) };
    const ctrl = new SlaMaintenanceController(
      { markBreached } as unknown as SlaRepository,
      sweep as unknown as SlaSweepRepository,
      { firstReplyBreached } as unknown as DomainEventPublisher,
    );
    return { ctrl, markBreached, firstReplyBreached, sweep };
  }

  const systemMd = () => {
    const m = new Metadata();
    m.set('x-actor-kind', 'system');
    return m;
  };
  const userMd = () => {
    const m = new Metadata();
    m.set('x-actor-account-id', 'acc-1');
    m.set('x-actor-user-id', 'u1');
    m.set('x-actor-permissions', 'crm.sla.manage,crm.inbox.view');
    return m;
  };

  it('*** fence 3: a USER actor is refused, however privileged ***', async () => {
    const { ctrl, sweep } = build([]);
    await expect(ctrl.sweepFirstReplySla({ limit: 10 }, userMd())).rejects.toBeInstanceOf(RpcException);
    // …and the unscoped read is never even reached.
    expect(sweep.findDueConversationIds).not.toHaveBeenCalled();
  });

  it('fence 3: missing metadata is refused too (fail-closed)', async () => {
    const { ctrl } = build([]);
    await expect(ctrl.sweepFirstReplySla({}, new Metadata())).rejects.toBeInstanceOf(RpcException);
  });

  it('*** fence 2: the response carries COUNTS ONLY — no ids of any kind ***', async () => {
    const { ctrl } = build([
      { account_id: 'acc-1', conversation_id: 'c1' },
      { account_id: 'acc-2', conversation_id: 'c2' },
    ]);
    const res = await ctrl.sweepFirstReplySla({ limit: 10 }, systemMd());
    expect(res).toEqual({ checked: 2, breached: 2, rulesApplied: 0 });
    const body = JSON.stringify(res);
    expect(body).not.toContain('acc-1');
    expect(body).not.toContain('c1');
  });

  it('marks each due conversation under ITS OWN account (the scoped follow-up)', async () => {
    const { ctrl, markBreached } = build([
      { account_id: 'acc-1', conversation_id: 'c1' },
      { account_id: 'acc-2', conversation_id: 'c2' },
    ]);
    await ctrl.sweepFirstReplySla({ limit: 10 }, systemMd());
    expect(markBreached).toHaveBeenNthCalledWith(1, 'acc-1', 'c1', expect.any(Date));
    expect(markBreached).toHaveBeenNthCalledWith(2, 'acc-2', 'c2', expect.any(Date));
  });

  // markBreached is the announce-once transition; only the caller that actually flipped the row emits.
  it('emits nothing for a row another tick already marked', async () => {
    const { ctrl, firstReplyBreached } = build([{ account_id: 'acc-1', conversation_id: 'c1' }], {
      marked: false,
    });
    const res = await ctrl.sweepFirstReplySla({ limit: 10 }, systemMd());
    expect(res).toEqual({ checked: 1, breached: 0, rulesApplied: 0 });
    expect(firstReplyBreached).not.toHaveBeenCalled();
  });

  it('reports how many rules ran, per breach', async () => {
    const { ctrl } = build([{ account_id: 'acc-1', conversation_id: 'c1' }], { ruleCount: 2 });
    await expect(ctrl.sweepFirstReplySla({ limit: 10 }, systemMd())).resolves.toEqual({
      checked: 1,
      breached: 1,
      rulesApplied: 2,
    });
  });

  // The measurement must not depend on any rule existing or working (US3 acceptance #2).
  it('a failing rule does not stop the sweep — the breach is still recorded', async () => {
    const markBreached = jest.fn().mockResolvedValue(true);
    const ctrl = new SlaMaintenanceController(
      { markBreached } as unknown as SlaRepository,
      {
        findDueConversationIds: jest.fn().mockResolvedValue([
          { account_id: 'acc-1', conversation_id: 'c1' },
          { account_id: 'acc-1', conversation_id: 'c2' },
        ]),
      } as unknown as SlaSweepRepository,
      {
        firstReplyBreached: jest.fn().mockRejectedValue(new Error('rule blew up')),
      } as unknown as DomainEventPublisher,
    );
    const res = await ctrl.sweepFirstReplySla({ limit: 10 }, systemMd());
    expect(res.breached).toBe(2);
    expect(markBreached).toHaveBeenCalledTimes(2);
  });

  it('applies a default batch when the caller omits one', async () => {
    const { ctrl, sweep } = build([]);
    await ctrl.sweepFirstReplySla({}, systemMd());
    expect(sweep.findDueConversationIds).toHaveBeenCalledWith(500, expect.any(Date));
  });
});
