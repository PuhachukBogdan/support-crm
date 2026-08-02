import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { RedisService } from '../queue/redis.service';
import { AuthMailClient } from '../auth/auth.client';

export const MAIL_SWEEP_QUEUE = 'crm-mail-sweep';
export const MAIL_SWEEP_JOB = 'send-due-emails';

/**
 * The mail sweep tick (feature 028, research R2/R3).
 *
 * ── This tick is the SAFETY NET, not the delivery path ──────────────────────────────────────────
 * A message is normally sent immediately after the request that produced it — a code that arrives
 * in one second and a code that arrives in eleven are different products to somebody signing in
 * twenty times a day. This tick exists for the case that attempt failed: a relay that was briefly
 * down, a process that died holding a claim, a message written a moment before a restart.
 *
 * ── Why a tick at all, rather than an interval inside auth ──────────────────────────────────────
 * A BullMQ *repeatable* job fires **once across replicas**; a `setInterval` inside auth fires once
 * per pod. That is the same reasoning feature 017 recorded for exports, and it is the only thing
 * the worker contributes here — it holds no outbox, renders nothing, and never sees a message.
 *
 * ⚠️ **Nothing about a message crosses the wire.** A batch size out, three counts back.
 */
@Injectable()
export class MailSweepJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailSweepJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(AuthMailClient) private readonly auth: AuthMailClient,
  ) {}

  private get intervalMs(): number {
    return clampInt(process.env.MAIL_SWEEP_INTERVAL_MS, 15_000, 1_000, 3_600_000);
  }
  private get batch(): number {
    return clampInt(process.env.MAIL_SWEEP_BATCH, 20, 1, 100);
  }

  async onModuleInit(): Promise<void> {
    this.queue = new Queue(MAIL_SWEEP_QUEUE, { connection: this.redis.client });
    this.worker = new Worker(MAIL_SWEEP_QUEUE, () => this.process(), {
      connection: this.redis.client,
      // One pass at a time: overlapping passes would only contend for the same claim predicate.
      concurrency: 1,
    });
    // A downed auth or Redis is a delayed message, never a dead process — the next tick retries.
    this.worker.on('failed', (_job, err) => {
      // ⚠️ The error's NAME only. Feature 014's lesson was to log the message too, and it is the
      // right lesson everywhere except here: a mail failure's message can quote the envelope, and
      // the envelope carries the recipient (Principle IV, FR-012).
      this.logger.warn(`mail sweep failed: ${err?.name ?? 'error'}`);
    });

    await this.queue.add(
      MAIL_SWEEP_JOB,
      {},
      { repeat: { every: this.intervalMs }, removeOnComplete: true, removeOnFail: 100 },
    );
    this.logger.log(`mail sweep scheduled every ${this.intervalMs}ms (batch ${this.batch})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }

  private async process(): Promise<void> {
    const res = await this.auth.sendDueEmails(this.batch);
    // Silence when there was nothing to do: a line every fifteen seconds saying "0" trains people
    // to stop reading the log, which is where the interesting lines also are.
    if (res.attempted > 0) {
      this.logger.log(
        `mail sweep: attempted=${res.attempted} sent=${res.sent} failed=${res.failed}`,
      );
    }
  }
}

/** Same clamp the other ticks use: a tuning knob must never become a hot loop. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
