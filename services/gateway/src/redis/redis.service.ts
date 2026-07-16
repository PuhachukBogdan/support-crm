import { Injectable, OnModuleDestroy } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';

/**
 * Gateway's own Redis connection (spec 003, US5). Used by the readiness aggregate to report
 * the gateway's cache/queue reachability. Lazy + non-fatal: a downed Redis degrades health,
 * never crashes the gateway (FR-012).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor() {
    this.client = new IORedis(process.env.REDIS_URL as string, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      // Fail fast when Redis is unreachable instead of reconnecting forever — keeps the
      // readiness probe bounded (never hangs, FR-012).
      retryStrategy: () => null,
    });
    this.client.on('error', () => undefined);
  }

  async ping(): Promise<void> {
    // The client is lazy — establish the connection on first probe. (Unlike the worker,
    // the gateway has no BullMQ queue eagerly opening it.) A failed connect throws →
    // reported as degraded, never crashes.
    if (['wait', 'end', 'close'].includes(this.client.status)) {
      await this.client.connect();
    }
    await this.client.ping();
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
