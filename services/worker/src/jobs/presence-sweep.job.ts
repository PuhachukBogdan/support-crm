import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { RedisService } from '../queue/redis.service';
import { UsersMaintenanceClient } from '../users/users.client';

export const PRESENCE_SWEEP_QUEUE = 'crm-presence-sweep';
export const PRESENCE_SWEEP_JOB = 'sweep-idle-presence';

/**
 * The auto-away tick (feature 025, roadmap 5.9 — US2 / FR-014).
 *
 * ── ⚠️ THIS FILE IS THE DELIVERABLE, not the sweep logic ────────────────────────────────────────
 * Feature 017 shipped `ExpireDueExports`: written, hosted, unit-tested and **called by nothing**, for
 * weeks. Track A structurally cannot see that, because a unit test does not know whether a scheduler
 * exists — every test of the logic passes whether or not anything ever runs it.
 *
 * Auto-away has the same shape and a worse failure mode: nothing errors, nothing looks broken, and
 * agents who went home simply stay "available" while live conversations are pushed at empty chairs.
 * `tests/worker/maintenance-ticks.spec.ts` asserts this job is registered and reaches the rpc; only
 * Track B can show it actually firing.
 *
 * ── Its own tick, not a passenger on the five-minute one ────────────────────────────────────────
 * The transition-stream health check rides the expiry sweep because a five-minute heartbeat is the
 * right frequency for "has recording stopped". This is different: the lag between somebody closing
 * their laptop and routing knowing it is added directly to the away threshold, and a five-minute
 * granularity would make a ten-minute threshold mean "somewhere between ten and fifteen". A separate
 * queue also means a stuck presence pass cannot delay artefact deletion, or the reverse.
 *
 * ── Idempotent by predicate ─────────────────────────────────────────────────────────────────────
 * A row the sweep has already lowered no longer matches the threshold it was lowered for, so a second
 * tick with no activity in between writes nothing. There is no retry counter and no "swept" column,
 * because a row that still matches IS the retry.
 */
@Injectable()
export class PresenceSweepJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PresenceSweepJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(UsersMaintenanceClient) private readonly users: UsersMaintenanceClient,
  ) {}

  /**
   * 🅿 PROVISIONAL, and deliberately far below the away threshold: the tick interval is added to the
   * threshold as lag, so a 60-second tick makes a ten-minute threshold mean "ten to eleven minutes"
   * rather than "ten to fifteen". Revised alongside the thresholds themselves, by ops.
   */
  private get intervalMs(): number {
    return clampInt(process.env.PRESENCE_SWEEP_INTERVAL_MS, 60_000, 5_000, 900_000);
  }
  private get batch(): number {
    return clampInt(process.env.PRESENCE_SWEEP_BATCH, 200, 1, 500);
  }

  async onModuleInit(): Promise<void> {
    this.queue = new Queue(PRESENCE_SWEEP_QUEUE, { connection: this.redis.client });
    this.worker = new Worker(PRESENCE_SWEEP_QUEUE, () => this.process(), {
      connection: this.redis.client,
      // One pass at a time. Overlapping passes read the same rows and both try to lower them; the
      // loser's writes are all no-ops, which is noise rather than progress.
      concurrency: 1,
    });
    this.worker.on('failed', (_job, err) => {
      // A presence sweep that silently stops is invisible from the outside: nothing errors, and work
      // keeps being pushed at people who went home. This line is the only warning an operator gets.
      this.logger.warn(`presence sweep failed: ${err?.name ?? 'error'}: ${firstLine(err?.message)}`);
    });

    await this.queue.add(
      PRESENCE_SWEEP_JOB,
      {},
      { repeat: { every: this.intervalMs }, removeOnComplete: true, removeOnFail: 100 },
    );
    this.logger.log(`presence sweep scheduled every ${this.intervalMs}ms (batch ${this.batch})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }

  private async process(): Promise<void> {
    const res = await this.users.sweepIdlePresence(this.batch);
    // Counts only — nothing identifying crosses this boundary, so nothing identifying can be logged.
    // ⚠️ And nothing is logged on a quiet pass: a line every minute saying "0 swept" would, over a
    // shift, be a record of when people are at their desks. That is the surveillance question this
    // feature refuses (FR-037), and it would arrive through a log line rather than a schema.
    if (res.toAway || res.toOffline || res.failed) {
      this.logger.log(
        `presence swept away=${res.toAway} offline=${res.toOffline} failed=${res.failed}`,
      );
    }
  }
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, n));
}

const firstLine = (m?: string): string => (m ?? '').split('\n')[0]!.slice(0, 200);
