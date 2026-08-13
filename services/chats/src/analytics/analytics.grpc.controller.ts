import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { StatusRepository } from '../status/status.repository';
import { PrismaService } from '../prisma.service';

/** The volume window: default and the server cap. Capped because the MVP reads the journal
 *  DIRECTLY (the operator's 2026-08-04 decision — the rollup store is post-MVP), and a bounded
 *  window is what keeps that honest about its own limits. */
const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

/**
 * ⭐ W20 (subpoints 6.2/6.3/6.4, roadmap 11.1 minimum) — the live numbers, straight from the rows.
 *
 * ── Everything branches on CATEGORIES, never on a status key ─────────────────────────────────────
 * "In work" is the account's NON-TERMINAL categories resolved through the status repository — the
 * same read the load counters use since feature 032 fixed the `['open','pending']` literal that
 * made escalated work count as nothing. `pending_by_agent` (6.4) resolves the `pending` category
 * the same way.
 *
 * ── Aggregates only ──────────────────────────────────────────────────────────────────────────────
 * Counts, keys and day buckets. No subject, no body, no customer identifier crosses this wire; the
 * agent axis carries OPERATOR ids (staff, resolved to names by a read the caller already holds).
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class AnalyticsController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StatusRepository) private readonly statuses: StatusRepository,
  ) {}

  @GrpcMethod('ChatsReadService', 'GetAnalyticsSnapshot')
  @RequiresChatsPermission('analytics.dashboard.view')
  async getAnalyticsSnapshot(req: { days?: number }, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const db = this.prisma.forAccount(ctx.accountId);
    const days = Math.min(Math.max(Number(req?.days ?? 0) || DEFAULT_DAYS, 1), MAX_DAYS);

    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const windowStart = new Date(todayStart.getTime() - (days - 1) * 86_400_000);

    const [nonTerminal, pendingKeys] = await Promise.all([
      this.statuses.nonTerminalKeys(ctx.accountId),
      this.statuses.keysOfCategory(ctx.accountId, 'pending'),
    ]);

    const [createdToday, openNow, byChannel, byAgent, pendingByAgent, reply, createdRows] =
      await Promise.all([
        db.conversation.count({ where: { created_at: { gte: todayStart } } }),
        // An account with NO non-terminal statuses configured is misconfigured; `in: []` correctly
        // answers zero rather than everything.
        db.conversation.count({ where: { status: { in: nonTerminal } } }),
        db.conversation.groupBy({
          by: ['channel'],
          where: { status: { in: nonTerminal } },
          _count: { _all: true },
        }),
        db.conversation.groupBy({
          by: ['assignee_operator_id'],
          where: { status: { in: nonTerminal } },
          _count: { _all: true },
        }),
        db.conversation.groupBy({
          by: ['assignee_operator_id'],
          where: { status: { in: pendingKeys } },
          _count: { _all: true },
        }),
        db.conversationSlaState.aggregate({
          where: { first_reply_seconds: { not: null } },
          _avg: { first_reply_seconds: true },
          _count: { first_reply_seconds: true },
        }),
        // The day buckets, computed here rather than by a raw GROUP BY date_trunc: a raw query
        // bypasses the account-scope extension, and re-adding the tenant filter by hand is exactly
        // the manual step that regresses. Bounded by the window cap above.
        db.conversation.findMany({
          where: { created_at: { gte: windowStart } },
          select: { created_at: true },
        }),
      ]);

    const perDay = new Map<string, number>();
    for (let i = 0; i < days; i++) {
      perDay.set(new Date(windowStart.getTime() + i * 86_400_000).toISOString().slice(0, 10), 0);
    }
    for (const row of createdRows as Array<{ created_at: Date }>) {
      const key = row.created_at.toISOString().slice(0, 10);
      perDay.set(key, (perDay.get(key) ?? 0) + 1);
    }

    const bucket = (rows: unknown[], keyField: string) =>
      (rows as Array<Record<string, unknown>>)
        .map((r) => ({
          key: String(r[keyField] ?? ''),
          count: Number((r._count as { _all?: number })?._all ?? 0),
        }))
        .sort((a, b) => b.count - a.count);

    const avg = (reply as { _avg: { first_reply_seconds: number | null } })._avg.first_reply_seconds;
    const replied = (reply as { _count: { first_reply_seconds: number } })._count.first_reply_seconds;

    return {
      createdToday,
      openNow,
      // -1 = nothing measured yet: a real state on a fresh account, distinct from "instant".
      avgFirstReplySeconds: avg === null ? -1 : Math.round(avg),
      firstReplyCount: replied,
      byChannel: bucket(byChannel as unknown[], 'channel'),
      byAgent: bucket(byAgent as unknown[], 'assignee_operator_id'),
      pendingByAgent: bucket(pendingByAgent as unknown[], 'assignee_operator_id'),
      volumeByDay: [...perDay.entries()].map(([key, count]) => ({ key, count })),
    };
  }
}
