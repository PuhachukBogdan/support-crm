import { Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * The gateway's ONE Redis connection, shared (extracted by feature 034, W4).
 *
 * ⚠️ `RedisService` used to be provided inside `HealthModule`, where the readiness probe needed it. When the
 * realtime edge needed one too, declaring it a second time in `WsModule` would have given the process **two
 * base connections** — Nest scopes a provider to the module that declares it, so the same class registered
 * twice is two instances, and nothing in either file would have said so.
 *
 * One module, imported by both. The realtime gateway still `duplicate()`s it for its subscriber, because an
 * ioredis client in subscribe mode may not run ordinary commands and the readiness probe needs to.
 */
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
