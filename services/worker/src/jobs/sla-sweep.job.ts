import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { RedisService } from '../queue/redis.service';
import { ChatsMaintenanceClient } from '../chats/chats.client';

export const SLA_SWEEP_QUEUE = 'crm-sla-sweep';
export const SLA_SWEEP_JOB = 'first-reply-sweep';

/**
 * The first-reply SLA sweep — the project's first real background job (feature 014, roadmap 4.7 /
 * research R2).
 *
 * ── Why a repeatable tick and not a timer per conversation ───────────────────────────────────────
 * Postgres is the source of truth; Redis holds one repeatable-job definition and nothing else. A
 * Redis flush or a worker restart therefore costs at most one tick of latency. With a delayed job per
 * clock, a lost job means a breach that is **never** detected — silently falsifying the requirement,
 * and impossible to notice after the fact because nobody is waiting on a breach.
 *
 * Idempotency comes for free: marking a row breached removes it from the sweep predicate, so an
 * overlapping or retried tick finds nothing. There is no dedup bookkeeping to get wrong.
 *
 * A BullMQ *repeatable* job also fires once across replicas — a `setInterval` inside chats would fire
 * once per pod.
 *
 * ── Accepted cost ───────────────────────────────────────────────────────────────────────────────
 * Detection latency is bounded by the interval, not exact: a 30 s tick records a breach up to 30 s
 * after the deadline, which is well inside a target measured in minutes. Test environments set a few
 * seconds so a breach is observable while watching.
 */
@Injectable()
export class SlaSweepJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlaSweepJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ChatsMaintenanceClient) private readonly chats: ChatsMaintenanceClient,
  ) {}

  private get intervalMs(): number {
    return clampInt(process.env.SLA_SWEEP_INTERVAL_MS, 30_000, 1_000, 3_600_000);
  }
  private get batch(): number {
    return clampInt(process.env.SLA_SWEEP_BATCH, 500, 1, 5_000);
  }

  async onModuleInit(): Promise<void> {
    this.queue = new Queue(SLA_SWEEP_QUEUE, { connection: this.redis.client });
    this.worker = new Worker(SLA_SWEEP_QUEUE, () => this.process(), {
      connection: this.redis.client,
      // One sweep at a time. Concurrency would only create overlapping ticks that each find nothing.
      concurrency: 1,
    });
    // A worker-level error must not take the process down: a downed chats or Redis is a degraded
    // sweep, and the next tick retries.
    //
    // The MESSAGE is logged, not just the error class — found the hard way on the first live run: a
    // failing sweep logged bare `Error`, and the actual cause (a table that did not exist yet) was
    // only visible in the chats logs. A silent-by-design job needs its one failure line to be useful.
    // Safe to log here: chats answers with static RpcException messages, the worker receives only
    // counts, and it holds no tenant data of its own to leak (Principle IV). Capped so a stack-laden
    // upstream message cannot flood the log.
    this.worker.on('failed', (job, err) =>
      this.logger.warn(`sla sweep job ${job?.id ?? '?'} failed: ${describe(err)}`),
    );
    this.worker.on('error', (err) => this.logger.warn(`sla sweep worker error: ${describe(err)}`));

    await this.schedule();
  }

  /**
   * Register the repeatable tick. A fixed `jobId` keeps re-registration idempotent across restarts and
   * replicas — without it every boot would add another repeatable entry and the sweep would run N
   * times per interval.
   */
  private async schedule(): Promise<void> {
    const every = this.intervalMs;
    try {
      await this.queue!.add(
        SLA_SWEEP_JOB,
        {},
        {
          repeat: { every },
          jobId: SLA_SWEEP_JOB,
          removeOnComplete: 20,
          removeOnFail: 50,
        },
      );
      this.logger.log(`first-reply SLA sweep scheduled every ${every}ms (batch ${this.batch})`);
    } catch (err) {
      // Never fatal: a worker that cannot schedule is degraded, not broken, and health reports Redis.
      this.logger.warn(`could not schedule the sla sweep: ${err instanceof Error ? err.name : 'error'}`);
    }
  }

  /** One tick. Counts only — chats never returns rows to us (research R3). */
  private async process(): Promise<void> {
    const res = await this.chats.sweepFirstReplySla(this.batch);
    if (res.checked > 0 || res.breached > 0) {
      // Counts are safe to log; there are no ids to leak (Principle IV).
      this.logger.log(
        `sla sweep: checked=${res.checked} breached=${res.breached} rulesApplied=${res.rulesApplied}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }
}

/** First line of the message, capped — enough to diagnose, short enough not to flood. */
function describe(err: unknown): string {
  if (!(err instanceof Error)) return 'error';
  const first = (err.message ?? '').split(/\r?\n/)[0]!.trim();
  return first ? `${err.name}: ${first.slice(0, 200)}` : err.name;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
