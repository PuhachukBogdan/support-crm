import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { RedisService } from '../queue/redis.service';
import { loadWorkerConfig, type WorkerConfig } from '../config';
import { ImapReaderService } from './imap-reader.service';

export const MAIL_INBOUND_SWEEP_QUEUE = 'crm-mail-inbound-sweep';
export const MAIL_INBOUND_SWEEP_JOB = 'take-in-unseen-mail';

/**
 * The inbound-mail safety net (feature 033, roadmap 6.4 — T046, FR-027b).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⚠️ **THIS IS THE SAFETY NET AND NEVER THE DELIVERY PATH.**
 *
 * Mail arrives because the mailbox TELLS us (`imap-reader.service.ts`, IMAP IDLE). This tick exists for
 * the three cases push cannot cover: the connection dropped and has not come back yet, the process died
 * mid-batch, or a message landed during a restart.
 *
 * The distinction is not bookkeeping. A tick that IS the delivery path makes latency a configuration
 * value — and the operator asked for real time by name. **If this interval ever starts to matter for how
 * fast mail appears, the push path is broken and this job is concealing it**, which is the worst of the
 * three outcomes because everything looks like it works.
 *
 * That is the same division feature 028 recorded for outbound identity mail, in the same words, and this
 * file is deliberately shaped like `jobs/mail-sweep.job.ts` so the two read as one pattern.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── Why the sweep cannot duplicate anything ─────────────────────────────────────────────────────
 * It re-reads the same unseen set the reader reads. That is safe for the reason stated in the reader's
 * header: at-most-once is the unique constraint on the message identifier (FR-032), not the connection
 * and not this schedule. A message the reader already took is already `\Seen` and already claimed.
 */
@Injectable()
export class InboundMailSweepJob implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InboundMailSweepJob.name);
  private readonly cfg: WorkerConfig = loadWorkerConfig();
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(ImapReaderService) private readonly reader: ImapReaderService,
  ) {}

  async onModuleInit(): Promise<void> {
    // No mailbox ⇒ no sweep. Registering a repeatable job that can never do anything would put a line in
    // the log every minute saying nothing, which is how people learn to stop reading the log.
    if (this.cfg.CHANNEL_IMAP.host === '' || this.cfg.CHANNEL_KEY === '') return;

    this.queue = new Queue(MAIL_INBOUND_SWEEP_QUEUE, { connection: this.redis.client });
    this.worker = new Worker(MAIL_INBOUND_SWEEP_QUEUE, () => this.process(), {
      connection: this.redis.client,
      // One pass at a time: overlapping passes would fetch the same unseen set and contend for nothing.
      concurrency: 1,
    });
    this.worker.on('failed', (_job, err) => {
      // ⚠️ The error's NAME only — a mail error's message can quote a header or the envelope, and the
      // envelope carries the customer's address (Principle IV, FR-047).
      this.logger.warn(`inbound mail sweep failed: ${err?.name ?? 'error'}`);
    });

    await this.queue.add(
      MAIL_INBOUND_SWEEP_JOB,
      {},
      {
        repeat: { every: this.cfg.CHANNEL_MAIL_SWEEP_INTERVAL_MS },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
    this.logger.log(
      `inbound mail sweep scheduled every ${this.cfg.CHANNEL_MAIL_SWEEP_INTERVAL_MS}ms (safety net, not the delivery path)`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }

  /**
   * One pass.
   *
   * ⚠️ It asks the reader to sweep **its own live connection** rather than opening a second one. A sweep
   * that dialled the mailbox itself would be a second IMAP session per replica — the exact multiplication
   * the lease exists to prevent — and it would need its own copy of the credentials and the egress guard.
   * When there is no live connection there is nothing to sweep and nothing to report: the reader is
   * already reconnecting, and its first act on reconnect is to take in everything unseen.
   */
  private async process(): Promise<void> {
    const counts = await this.reader.sweepUnseen();
    if (counts === null) {
      // Not an error. The reader holds no connection — either another replica does, or this one is
      // between reconnects. Both are ordinary, and both mean this pass has no work.
      return;
    }
    if (counts.taken > 0) {
      // ⭐ Worth a line at WARN rather than LOG: anything the SWEEP took in is a message the PUSH path
      // missed, which is the signal this job exists to surface. Silence here is the healthy state.
      this.logger.warn(
        `inbound mail sweep took in ${counts.taken} message(s) the push path missed — check the IDLE connection`,
      );
    }
  }
}
