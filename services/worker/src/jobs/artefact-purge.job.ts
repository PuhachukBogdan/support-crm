import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { RedisService } from '../queue/redis.service';
import { UsersMaintenanceClient } from '../users/users.client';

export const ARTEFACT_PURGE_QUEUE = 'crm-artefact-purge';
export const ARTEFACT_PURGE_JOB = 'purge-expired-artefacts';

/**
 * The artefact purge tick (feature 017, US3 — FR-013/FR-014, research R8).
 *
 * Same shape as the SLA sweep and the export runner, and for the same reasons: a BullMQ repeatable job
 * fires once across replicas where a `setInterval` inside `users` would fire once per pod, and the
 * worker's whole contribution is the clock. It holds no artefact state, knows no expiry, and never sees
 * a byte — `users` owns the credentials and therefore owns the deletion.
 *
 * ── Slower than the export runner, on purpose ────────────────────────────────────────────────────
 * 5 minutes rather than 10 seconds: nobody is waiting for a purge. The export runner is fast because a
 * person is watching a status; expiry is a deadline measured in hours, so a tick every five minutes
 * means an artefact outlives its window by at most five minutes — which is the same bound the
 * download's own `expires_at` check makes irrelevant to CORRECTNESS (the refusal never depends on how
 * recently a tick ran).
 *
 * ── What a failure means here ────────────────────────────────────────────────────────────────────
 * Nothing is lost. `users` leaves a row whose bytes it could not delete, so the predicate still selects
 * it and the next tick tries again — idempotence with no retry bookkeeping, which is why this job has no
 * error handling beyond logging. The one thing it must not do is stop firing.
 */
@Injectable()
export class ArtefactPurgeJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ArtefactPurgeJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(UsersMaintenanceClient) private readonly users: UsersMaintenanceClient,
  ) {}

  private get intervalMs(): number {
    return clampInt(process.env.ARTEFACT_PURGE_INTERVAL_MS, 300_000, 1_000, 3_600_000);
  }
  private get batch(): number {
    return clampInt(process.env.ARTEFACT_PURGE_BATCH, 100, 1, 1_000);
  }

  async onModuleInit(): Promise<void> {
    this.queue = new Queue(ARTEFACT_PURGE_QUEUE, { connection: this.redis.client });
    this.worker = new Worker(ARTEFACT_PURGE_QUEUE, () => this.process(), {
      connection: this.redis.client,
      // One pass at a time. Overlapping passes would select the same rows and race on the same objects,
      // and the second one's deletes would all report `object_missing` — noise, not progress.
      concurrency: 1,
    });
    this.worker.on('failed', (_job, err) => {
      // The MESSAGE, not just the class — feature 014's live lesson. A purge that silently stops working
      // is the failure mode that turns "expiry is a deletion" back into "expiry is a flag", so this line
      // is the only warning an operator gets. Never a key, never a filename (SEC-26).
      this.logger.warn(`artefact purge failed: ${err?.name ?? 'error'}: ${firstLine(err?.message)}`);
    });

    await this.queue.add(
      ARTEFACT_PURGE_JOB,
      {},
      {
        repeat: { every: this.intervalMs },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    this.logger.log(`artefact purge scheduled every ${this.intervalMs}ms (batch ${this.batch})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }

  private async process(): Promise<void> {
    const res = await this.users.purgeExpiredArtefacts(this.batch);
    // Counts only — nothing identifying crosses this boundary, so nothing identifying can be logged.
    // `objectMissing` alone is deliberately NOT logged: it is the normal steady state once a row's bytes
    // have been removed by an earlier partial pass, and logging it every five minutes would train
    // whoever reads these lines to ignore them.
    if (res.purged || res.failed) {
      this.logger.log(
        `artefacts: purged=${res.purged} objectMissing=${res.objectMissing} failed=${res.failed}`,
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
