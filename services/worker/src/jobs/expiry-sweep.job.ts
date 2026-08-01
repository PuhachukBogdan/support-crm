import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { RedisService } from '../queue/redis.service';
import { ChatsMaintenanceClient } from '../chats/chats.client';
import { UsersMaintenanceClient } from '../users/users.client';

/**
 * The queue name is unchanged from when this job only did the purge half.
 *
 * Renaming it would leave the old repeatable entry in Redis with no worker attached, quietly queueing
 * jobs nobody processes. The CLASS is named for what it does; the queue string is an identity in Redis.
 */
export const EXPIRY_SWEEP_QUEUE = 'crm-artefact-purge';
export const EXPIRY_SWEEP_JOB = 'sweep-expired-exports';

/**
 * The expiry sweep (feature 017, US3 — FR-013/FR-014, research R7/R8).
 *
 * ── ⚠️ FOUND ON TRACK B (2026-07-28): the chats half had no tick at all ─────────────────────────
 * `ChatsMaintenanceService.ExpireDueExports` was written, hosted, unit-tested and **called by nothing**.
 * The consequence was not a security hole — the download refuses on `expires_at` directly, so an expired
 * artefact was never served — but every completed export stayed `ready` for ever, holding a dangling
 * `upload_id` pointing at bytes the purge had already destroyed. A status field that never reaches its
 * terminal value is a lie the product tells about itself, and `GET /exports` would show it.
 *
 * Track A could not see it: the unit tests call `expireDueExports` directly, and nothing in a unit test
 * knows whether a scheduler exists. Precisely 015's live-only defect in a new place — that one was a
 * hosted PACKAGE with an unwired handler; this was a wired handler with no caller.
 *
 * ── Why the two halves are ONE tick ─────────────────────────────────────────────────────────────
 * Expiry is two writes in two databases: `chats` flips the record to `expired` and clears its artefact
 * reference; `users` deletes the bytes and the row. They must not coordinate (Principle VIII — neither
 * reads the other's database, and a two-phase handshake between two services is wrong whenever one of
 * them is restarting), and both derive their predicate from ONE catalogue constant, so running them from
 * the same clock is the whole of the coupling they need.
 *
 * Failures are independent by construction: each call is awaited separately, so `users` being down does
 * not stop `chats` from expiring records, and either half left undone is simply found again next tick.
 *
 * ── Slower than the export runner, on purpose ────────────────────────────────────────────────────
 * 5 minutes rather than 10 seconds: nobody is waiting for an expiry. An artefact therefore outlives its
 * window by at most one interval — which is irrelevant to CORRECTNESS, because the download's own
 * `expires_at` check refuses regardless of how recently a tick ran.
 */
@Injectable()
export class ExpirySweepJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExpirySweepJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ChatsMaintenanceClient) private readonly chats: ChatsMaintenanceClient,
    @Inject(UsersMaintenanceClient) private readonly users: UsersMaintenanceClient,
  ) {}

  private get intervalMs(): number {
    return clampInt(process.env.ARTEFACT_PURGE_INTERVAL_MS, 300_000, 1_000, 3_600_000);
  }
  private get batch(): number {
    return clampInt(process.env.ARTEFACT_PURGE_BATCH, 100, 1, 1_000);
  }

  async onModuleInit(): Promise<void> {
    this.queue = new Queue(EXPIRY_SWEEP_QUEUE, { connection: this.redis.client });
    this.worker = new Worker(EXPIRY_SWEEP_QUEUE, () => this.process(), {
      connection: this.redis.client,
      // One pass at a time. Overlapping passes select the same rows and race on the same objects, and the
      // loser's deletes all report `object_missing` — noise, not progress.
      concurrency: 1,
    });
    this.worker.on('failed', (_job, err) => {
      // A sweep that silently stops working is what turns "expiry is a deletion" back into "expiry is a
      // flag", so this line is the only warning an operator gets. Never a key, never a filename (SEC-26).
      this.logger.warn(`expiry sweep failed: ${err?.name ?? 'error'}: ${firstLine(err?.message)}`);
    });

    await this.queue.add(
      EXPIRY_SWEEP_JOB,
      {},
      { repeat: { every: this.intervalMs }, removeOnComplete: true, removeOnFail: 100 },
    );
    this.logger.log(`expiry sweep scheduled every ${this.intervalMs}ms (batch ${this.batch})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }

  private async process(): Promise<void> {
    // Awaited separately and reported separately: one half failing must not skip the other, and an
    // operator has to be able to tell WHICH half is stuck.
    let expired = 0;
    try {
      expired = (await this.chats.expireDueExports(this.batch)).expired;
    } catch (err) {
      this.logger.warn(`expire records failed: ${(err as Error)?.name ?? 'error'}`);
    }
    if (expired) this.logger.log(`exports expired=${expired}`);

    // ── Feature 023 (roadmap 4.8a): is the transition stream alive? ─────────────────────────────
    //
    // It rides THIS tick rather than getting its own for one reason: a five-minute heartbeat is
    // exactly the right frequency for "has recording stopped", and a second scheduler for a single
    // counts-only call would be more moving parts than the question deserves.
    //
    // ⚠️ It must be reached from a job at all, or `tests/worker/maintenance-ticks.spec.ts` fails the
    // build — the guard feature 017 added after `ExpireDueExports` shipped wired to nothing. Making
    // the call is what turns "the rpc exists" into "the rpc runs".
    //
    // Logged only when the stream looks STOPPED. A line every five minutes saying everything is fine
    // trains whoever reads the logs to ignore them, which is how the silence gets missed.
    try {
      const health = await this.chats.reportTransitionStreamHealth();
      if (health.total !== '0' && health.lastHour === '0') {
        this.logger.warn(
          `transition stream: nothing recorded in the last hour (total=${health.total}, newest=${health.newestAt})`,
        );
      }
    } catch (err) {
      this.logger.warn(`transition health check failed: ${(err as Error)?.name ?? 'error'}`);
    }

    const res = await this.users.purgeExpiredArtefacts(this.batch);
    // Counts only — nothing identifying crosses this boundary, so nothing identifying can be logged.
    // `objectMissing` alone is deliberately not logged: it is the normal steady state after a partial
    // pass, and a line every five minutes trains whoever reads them to ignore them.
    if (res.purged || res.failed) {
      this.logger.log(
        `artefacts purged=${res.purged} objectMissing=${res.objectMissing} failed=${res.failed}`,
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
