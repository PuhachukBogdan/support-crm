import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 * THE SECOND UNSCOPED READ IN THIS SERVICE — and it is COUNTS ONLY. Read this before changing it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Feature 023, roadmap 4.8a (FR-012). Sibling of `sla/sla-sweep.repository.ts`, which carries the full
 * reasoning for why an unscoped tenant read can be judged compliant with Principle I rather than a
 * violation. The same five fences apply here, and two of them are stronger:
 *
 *   1. **Counts and one timestamp. No ids at all** — not even the id-only select the SLA sweep needs.
 *      There is nothing here to attribute to an account, so there is nothing to leak.
 *   2. **Nothing leaves the service** except those counts, in a response with no row in it.
 *   3. **No caller can reach it**: invoked only from `ChatsMaintenanceService`, which requires
 *      `x-actor-kind: system` and has no gateway route.
 *   4. **No writes follow.** The SLA sweep selects work and then acts on it under `forAccount`; this
 *      reads and returns. It cannot cause a change to anything.
 *   5. **Bounded by construction** — a `count` and a `max`, not a scan the caller can widen.
 *
 * ⚠️ **Why this method exists at all, when nothing consumes the stream yet.** That is exactly the
 * reason. The aggregation store is roadmap 11.0; until it exists there is no other way to notice the
 * stream has stopped being written — and this codebase has shipped write-only machinery that rotted
 * silently twice: a hosted gRPC package whose handler was never registered (feature 015), and a
 * maintenance rpc reached by no tick at all (feature 017). A store nothing can inspect cannot be shown
 * to work, on Track B or ever.
 *
 * ⚠️ **Correction to my own note (2026-08-01):** `prisma.scoped-models.ts` originally claimed this
 * table has "no method-level exception, because nothing reads transitions across accounts". Writing
 * this file proved that wrong — the health count IS such a read. The comment there now says so. The
 * lesson is the project's own: when a guarantee holds, check WHICH code makes it hold.
 *
 * **Do not add anything else to this file.** Its value is that it is one method that returns numbers.
 */
export interface TransitionStreamHealth {
  /** Every transition ever recorded, across accounts. A number, not a set. */
  total: number;
  /** Recorded in the trailing hour — the signal that the stream is alive *now*, not merely non-empty. */
  lastHour: number;
  /** The newest `occurred_at`, or null when the stream is empty. A timestamp carries no tenant data. */
  newestAt: Date | null;
}

@Injectable()
export class TransitionHealthRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async report(now: Date): Promise<TransitionStreamHealth> {
    const since = new Date(now.getTime() - 60 * 60 * 1000);

    const [total, lastHour, newest] = await Promise.all([
      this.prisma.conversationTransition.count(),
      this.prisma.conversationTransition.count({ where: { occurred_at: { gte: since } } }),
      this.prisma.conversationTransition.findFirst({
        orderBy: { occurred_at: 'desc' },
        // The ONLY column read anywhere in this file. Deliberately not `select: true` on the row.
        select: { occurred_at: true },
      }),
    ]);

    return { total, lastHour, newestAt: newest?.occurred_at ?? null };
  }
}
