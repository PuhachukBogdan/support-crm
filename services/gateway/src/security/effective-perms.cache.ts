import { Inject, Injectable } from '@nestjs/common';
import type { EffectivePermissions } from '@crm/common';
import { RedisService } from '../redis/redis.service';

const TTL_SECONDS = 30; // short — freshness comes from explicit invalidation on any privilege change.
const keyOf = (accountId: string, userId: string) => `rbac:eff:${accountId}:${userId}`;

/**
 * Effective-permission projection cache (feature 011, T011 / R-1). Auth is the source of truth;
 * the gateway resolves a caller's effective set once and caches it here so repeat requests within
 * the TTL skip the gRPC hop (Principle VII). Explicit `invalidate` on any privilege change (US3)
 * keeps overrides/reset immediate. Best-effort: a Redis error degrades to a cache MISS (the guard
 * then resolves via Auth), never a failure — but it NEVER fails-open on authorization itself.
 */
@Injectable()
export class EffectivePermsCache {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  async get(accountId: string, userId: string): Promise<EffectivePermissions | null> {
    try {
      const raw = await this.redis.client.get(keyOf(accountId, userId));
      return raw ? (JSON.parse(raw) as EffectivePermissions) : null;
    } catch {
      return null; // miss → caller resolves via Auth.
    }
  }

  async set(accountId: string, userId: string, perms: EffectivePermissions): Promise<void> {
    try {
      await this.redis.client.set(keyOf(accountId, userId), JSON.stringify(perms), 'EX', TTL_SECONDS);
    } catch {
      /* best-effort cache write */
    }
  }

  async invalidate(accountId: string, userId: string): Promise<void> {
    try {
      await this.redis.client.del(keyOf(accountId, userId));
    } catch {
      /* best-effort */
    }
  }
}
