import { Inject, Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

const TTL_SECONDS = 900; // 15 min — a preview is a short inspection session, not a durable state.
const keyOf = (accountId: string, userId: string) => `rbac:viewas:${accountId}:${userId}`;

/**
 * View-as preview context (feature 011, US5 / R-5). A transient Redis entry bound to the caller's
 * session naming the role they are previewing. The gateway PermissionGuard consults it to (a) shape
 * reads as the previewed role and (b) refuse any write while it is active (read-only, SC-009).
 *
 * Fail-safe: a Redis error → `get` returns null → no preview applies (the caller is just a normal
 * super-admin session). Preview is a convenience layer; degrading to the real session is safe.
 */
@Injectable()
export class ViewAsContext {
  constructor(@Inject(RedisService) private readonly redis: RedisService) {}

  async get(accountId: string, userId: string): Promise<string | null> {
    try {
      return await this.redis.client.get(keyOf(accountId, userId));
    } catch {
      return null; // no preview applies.
    }
  }

  async set(accountId: string, userId: string, role: string): Promise<void> {
    await this.redis.client.set(keyOf(accountId, userId), role, 'EX', TTL_SECONDS);
  }

  async clear(accountId: string, userId: string): Promise<void> {
    try {
      await this.redis.client.del(keyOf(accountId, userId));
    } catch {
      /* best-effort */
    }
  }
}
