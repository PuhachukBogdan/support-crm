import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { RedisService } from '../queue/redis.service';
import { ChatsMaintenanceClient } from '../chats/chats.client';

export const OUTBOUND_TICK_QUEUE = 'crm-channel-outbound';
export const OUTBOUND_TICK_JOB = 'send-due-channel-messages';

/**
 * The outbound tick (feature 033, roadmap 6.5 — T068).
 *
 * ── Why a tick at all, when the reply is written by a request ────────────────────────────────────
 * The message-post transaction writes the intent; nothing sends it inside that request. Deliberately:
 * an SMTP session inside a write transaction would hold a database transaction open across a network
 * call to a third party, and the agent's reply would appear to fail whenever a relay was slow. The tick
 * is the sender, and the delay it costs is seconds.
 *
 * ⚠️ A BullMQ **repeatable** job fires once across replicas — which is what makes this safe to run in
 * every pod. That is the same reasoning features 017 and 028 recorded, and it is the reason this is a job
 * rather than a `setInterval` inside chats.
 *
 * ── What crosses this boundary ──────────────────────────────────────────────────────────────────
 * A batch size out, three counts back. **Never a recipient, a subject or a body** — chats holds the
 * outbox, fetches the envelope from `users` at send time and opens the connection; the worker only says
 * "now" (research R6, FR-044).
 */
@Injectable()
export class OutboundTickJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboundTickJob.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ChatsMaintenanceClient) private readonly chats: ChatsMaintenanceClient,
  ) {}

  /**
   * 15 seconds, matching feature 028's mail sweep — an agent's reply is something a person is waiting
   * on, like a login code and unlike a breach. Clamped, so a typo cannot make it a hot loop against a
   * relay.
   */
  private get intervalMs(): number {
    return clampInt(process.env.CHANNEL_OUTBOUND_INTERVAL_MS, 15_000, 1_000, 3_600_000);
  }
  private get batch(): number {
    return clampInt(process.env.CHANNEL_OUTBOUND_BATCH, 20, 1, 100);
  }

  async onModuleInit(): Promise<void> {
    this.queue = new Queue(OUTBOUND_TICK_QUEUE, { connection: this.redis.client });
    this.worker = new Worker(OUTBOUND_TICK_QUEUE, () => this.process(), {
      connection: this.redis.client,
      // One pass at a time: overlapping passes would only contend for the same claim predicate.
      concurrency: 1,
    });
    this.worker.on('failed', (_job, err) => {
      // ⚠️ The error's NAME only. A mail failure's message can quote the envelope, and here the envelope
      // carries a CUSTOMER's address — the one place this diverges from feature 028's otherwise identical
      // logging (research R6).
      this.logger.warn(`outbound tick failed: ${err?.name ?? 'error'}`);
    });

    await this.queue.add(
      OUTBOUND_TICK_JOB,
      {},
      { repeat: { every: this.intervalMs }, removeOnComplete: true, removeOnFail: 100 },
    );
    this.logger.log(`channel outbound scheduled every ${this.intervalMs}ms (batch ${this.batch})`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }

  private async process(): Promise<void> {
    const res = await this.chats.sendDueChannelMessages(this.batch);
    // Silence when there was nothing to do: a line every fifteen seconds saying "0" trains people to
    // stop reading the log, which is where the interesting lines also are.
    if (res.attempted > 0) {
      this.logger.log(
        `channel outbound: attempted=${res.attempted} sent=${res.sent} failed=${res.failed}`,
      );
    }
  }
}

/** The same clamp every tick uses: a tuning knob must never become a hot loop. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}
