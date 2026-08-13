import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Reflector } from '@nestjs/core';
import type { PrismaService } from '../prisma.service';
import type { StatusRepository } from '../status/status.repository';
import { AnalyticsController } from './analytics.grpc.controller';
import { ChatsAccessGuard } from '../security/permission.guard';
import { REQUIRED_CHATS_PERMISSION_KEY } from '../security/requires-chats-permission.decorator';

/**
 * ⭐ W20 (6.2/6.3/6.4) — the analytics snapshot. The claims: gated `analytics.dashboard.view` at
 * this tier; "in work" and "pending" resolve through the STATUS REPOSITORY's categories (never a
 * key list of this file's own — the 032 lesson); an unmeasured first reply is -1, distinct from
 * instant; the day series is ZERO-FILLED (a day with nothing is a zero, not a missing bar).
 */

function harness(opts: { avg?: number | null; replied?: number } = {}) {
  const calls: Record<string, unknown[]> = { count: [], groupBy: [], findMany: [] };
  const scoped = {
    conversation: {
      count: async (args: unknown) => {
        calls.count!.push(args);
        return calls.count!.length === 1 ? 3 : 7; // createdToday=3, openNow=7
      },
      groupBy: async (args: { by: string[] }) => {
        calls.groupBy!.push(args);
        if (args.by[0] === 'channel') return [{ channel: 'email', _count: { _all: 5 } }, { channel: null, _count: { _all: 2 } }];
        return [{ assignee_operator_id: 'op-1', _count: { _all: 4 } }, { assignee_operator_id: null, _count: { _all: 3 } }];
      },
      findMany: async (args: unknown) => {
        calls.findMany!.push(args);
        return [{ created_at: new Date() }, { created_at: new Date() }];
      },
    },
    conversationSlaState: {
      aggregate: async () => ({
        _avg: { first_reply_seconds: opts.avg === undefined ? 90.4 : opts.avg },
        _count: { first_reply_seconds: opts.replied ?? 12 },
      }),
    },
  };
  const prisma = { forAccount: jest.fn(() => scoped) } as unknown as PrismaService;
  const statuses = {
    nonTerminalKeys: jest.fn(async () => ['new', 'open', 'pending_x']),
    keysOfCategory: jest.fn(async () => ['pending_x']),
  } as unknown as StatusRepository;
  return { controller: new AnalyticsController(prisma, statuses), statuses, calls };
}

const md = (perms: string[]): Metadata => {
  const m = new Metadata();
  m.set('x-actor-account-id', 'acc-1');
  m.set('x-actor-user-id', 'u-1');
  m.set('x-actor-permissions', perms.join(','));
  return m;
};
const VIEWER = ['crm.inbox.view', 'analytics.dashboard.view'];

describe('the gate', () => {
  it('⛔ declares analytics.dashboard.view, and the guard refuses an agent without it', () => {
    expect(
      new Reflector().get<string>(
        REQUIRED_CHATS_PERMISSION_KEY,
        AnalyticsController.prototype.getAnalyticsSnapshot,
      ),
    ).toBe('analytics.dashboard.view');
    const guard = new ChatsAccessGuard(new Reflector());
    const ctx = (perms: string[]) =>
      ({
        getType: () => 'rpc',
        getHandler: () => AnalyticsController.prototype.getAnalyticsSnapshot,
        getClass: () => AnalyticsController,
        switchToRpc: () => ({ getContext: () => md(perms) }),
      }) as never;
    expect(() => guard.canActivate(ctx(['crm.inbox.view']))).toThrow(RpcException);
    expect(guard.canActivate(ctx(VIEWER))).toBe(true);
  });
});

describe('the snapshot', () => {
  it('⭐ "in work" and "pending" resolve through CATEGORIES — the status repository, never a key list here', async () => {
    const { controller, statuses } = harness();
    await controller.getAnalyticsSnapshot({}, md(VIEWER));
    expect(statuses.nonTerminalKeys).toHaveBeenCalledWith('acc-1');
    expect(statuses.keysOfCategory).toHaveBeenCalledWith('acc-1', 'pending');
  });

  it('carries the numbers, sorted buckets, and a labelled absence for the unassigned', async () => {
    const { controller } = harness();
    const res = await controller.getAnalyticsSnapshot({}, md(VIEWER));
    expect(res.createdToday).toBe(3);
    expect(res.openNow).toBe(7);
    expect(res.avgFirstReplySeconds).toBe(90);
    expect(res.byChannel[0]).toEqual({ key: 'email', count: 5 });
    expect(res.byChannel[1]).toEqual({ key: '', count: 2 }); // '' = no channel, kept, not dropped
    expect(res.byAgent[1]).toEqual({ key: '', count: 3 }); // '' = unassigned
  });

  it('an unmeasured first reply is -1 — a real state, distinct from "instant"', async () => {
    const { controller } = harness({ avg: null, replied: 0 });
    const res = await controller.getAnalyticsSnapshot({}, md(VIEWER));
    expect(res.avgFirstReplySeconds).toBe(-1);
    expect(res.firstReplyCount).toBe(0);
  });

  it('⭐ the day series is ZERO-FILLED for the whole window — a quiet day is a zero, not a hole', async () => {
    const { controller } = harness();
    const res = await controller.getAnalyticsSnapshot({ days: 5 }, md(VIEWER));
    expect(res.volumeByDay).toHaveLength(5);
    expect(res.volumeByDay.at(-1)!.count).toBe(2); // both fixture rows land today
    expect(res.volumeByDay.slice(0, 4).every((d: { count: number }) => d.count === 0)).toBe(true);
  });

  it('the window is server-capped — 5000 days is answered as 90', async () => {
    const { controller } = harness();
    const res = await controller.getAnalyticsSnapshot({ days: 5000 }, md(VIEWER));
    expect(res.volumeByDay).toHaveLength(90);
  });
});
