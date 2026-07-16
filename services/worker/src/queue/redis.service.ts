import { Injectable, OnModuleDestroy } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import { Queue } from 'bullmq';

/**
 * Redis connection for the worker (spec 003, US5 / FR-011). The service connects to the
 * shared cache/queue store via BullMQ; a Queue is created on the shared ioredis connection
 * to realize "connects via BullMQ" (real job producers/consumers are Phase 7).
 *
 * Lazy + non-fatal: the connection does NOT block boot and connection errors do NOT crash
 * the process — a downed Redis is reported as degraded by the health probe (FR-012).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  readonly queue: Queue;

  constructor() {
    // REDIS_URL is validated by loadWorkerConfig() before the app is created.
    this.client = new IORedis(process.env.REDIS_URL as string, {
      lazyConnect: true,
      // BullMQ requires this to be null on its connection.
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    });
    // Swallow connection errors — health reports reachability, we never crash on them.
    this.client.on('error', () => undefined);
    this.queue = new Queue('crm-health', { connection: this.client });
  }

  /** Round-trip Redis; throws if unreachable (probed by the health controller). */
  async ping(): Promise<void> {
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    this.client.disconnect();
  }
}
