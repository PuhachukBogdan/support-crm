import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { RedisService } from '../queue/redis.service';
import { ChatsMaintenanceClient } from '../chats/chats.client';

export const EXPORT_RUN_QUEUE = 'crm-export-run';
export const EXPORT_RUN_JOB = 'run-due-exports';

/**
 * The export runner tick (feature 017, roadmap 4.10 / research R3).
 *
 * ── This tick IS the queue ───────────────────────────────────────────────────────────────────────
 * `chats` has no Redis configuration at all, so it cannot enqueue. Giving it a queue client, new config
 * keys and a compose edit would buy a few seconds of latency on an operation measured in minutes. Instead
 * the request writes a `queued` row and this claims it. Postgres stays the source of truth, so a Redis
 * flush costs one tick of latency rather than losing work — the same reasoning feature 014 recorded when
 * it chose a repeatable sweep over a delayed job per clock.
 *
 * Idempotency needs no bookkeeping: `queued → running` is a CONDITIONAL update, so two overlapping ticks
 * both try and exactly one wins. A BullMQ *repeatable* job also fires once across replicas, where a
 * `setInterval` inside chats would fire once per pod.
 *
 * ── Faster than the SLA sweep, on purpose ────────────────────────────────────────────────────────
 * 10 s rather than 30: someone is actively waiting for an export, unlike a breach that nobody is watching.
 * The accepted cost is the same in kind — queue latency is bounded by the interval, not zero.
 */
@Injectable()
export class ExportRunJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExportRunJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ChatsMaintenanceClient) private readonly chats: ChatsMaintenanceClient,
  ) {}

  private get intervalMs(): number {
    return clampInt(process.env.EXPORT_RUN_INTERVAL_MS, 10_000, 1_000, 3_600_000);
  }
  private get batch(): number {
    return clampInt(process.env.EXPORT_RUN_BATCH, 5, 1, 100);
  }

  async onModuleInit(): Promise<void> {
    this.queue = new Queue(EXPORT_RUN_QUEUE, { connection: this.redis.client });
    this.worker = new Worker(EXPORT_RUN_QUEUE, () => this.process(), {
      connection: this.redis.client,
      // One pass at a time: an export is produced inside chats, and overlapping passes would only
      // contend for the same claim predicate.
      concurrency: 1,
    });
    // A worker-level error must not take the process down: a downed chats or Redis is a delayed export,
    // and the next tick retries.
    this.worker.on('failed', (_job, err) => {
      // The MESSAGE, not just the class — feature 014's live lesson: a failing sweep logged a bare
      // `Error` and the actual cause was only visible in the chats logs. Never an export id, never a
      // filter value (SEC-26).
      this.logger.warn(`export run failed: ${err?.name ?? 'error'}: ${firstLine(err?.message)}`);
    });

    await this.queue.add(
      EXPORT_RUN_JOB,
      {},
      {
        repeat: { every: this.intervalMs },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    this.logger.log(`export runner scheduled every ${this.intervalMs}ms (batch ${this.batch})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }

  private async process(): Promise<void> {
    const res = await this.chats.runDueExports(this.batch);
    // Counts only — nothing identifying crosses this boundary, so nothing identifying can be logged.
    if (res.claimed || res.recoveredStale) {
      this.logger.log(
        `exports: claimed=${res.claimed} completed=${res.completed} failed=${res.failed} recoveredStale=${res.recoveredStale}`,
      );
    }
  }
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function firstLine(message: string | undefined): string {
  return ((message ?? '').split('\n')[0] ?? '').slice(0, 200);
}
