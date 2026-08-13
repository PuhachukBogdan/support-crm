import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import { realtimeChannel, type RealtimeEvent, type RealtimeEventKind } from '@crm/common';

/**
 * The realtime publisher (feature 034, MVP block W4 — roadmap 7.1, FR-003/FR-004/FR-005).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ⭐ **THIS IS THE FIRST REDIS IN `chats`, AND IT IS PUBLISH-ONLY.**
 *
 * The service deliberately had none. `export/export.maintenance.ts` states the reason: *"`chats` has no
 * Redis configuration at all, so it cannot enqueue. Rather than give it a queue client … Postgres stays
 * the source of truth."* That decision protected two properties, and both survive here:
 *
 *   · **Postgres remains the source of truth** — a `PUBLISH` writes nothing and stores nothing.
 *   · **There is no second store of work** — nothing is enqueued, claimed, retried or read back. The
 *     event is a *hint that a read is worth doing*, and losing one costs a client a stale row until its
 *     next ordinary read.
 *
 * `tests/realtime/publish-only.spec.ts` holds that line structurally: `subscribe`, `psubscribe`, `Queue`,
 * `Worker`, `set(`, `get(` anywhere in `services/chats/src` fail the build. The door opened here is the
 * width of one verb, and a guard keeps it that width.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── ⚠️ ABSENT `REDIS_URL` MEANS INERT, NOT BROKEN ───────────────────────────────────────────────
 * A deployment with no socket edge is legitimate — as is the entire unit-test suite. So this follows the
 * `CHANNEL_IMAP_HOST` reading (*an absent mailbox is a configuration, not an error*) rather than the
 * `GRPC_URL` one (*refuse to start*). Nothing crash-loops because realtime is not configured.
 *
 * ── ⚠️ EVERY PUBLISH IS BEST-EFFORT, AND THAT IS A REQUIREMENT ──────────────────────────────────
 * A customer's message must not fail to be recorded because Redis blinked. Failures are logged **by
 * class** and swallowed, the same rule the in-process automation dispatcher already follows for a broken
 * rule. ⇒ *A notification may be lost; a fact may not.*
 */
@Injectable()
export class RealtimePublisher implements OnModuleDestroy {
  private readonly logger = new Logger(RealtimePublisher.name);
  private client?: Redis;
  private readonly url = (process.env.REDIS_URL ?? '').trim();

  /** Built on first use so a service with no socket edge never opens a connection at all. */
  private connection(): Redis | undefined {
    if (this.url === '') return undefined;
    if (!this.client) {
      const client = new IORedis(this.url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        // A downed Redis must degrade the socket, never queue writes in memory or retry for ever behind
        // a request. Same posture as the gateway's own client.
        retryStrategy: () => null,
        enableOfflineQueue: false,
      });
      /**
       * ⚠️ Attached exactly ONCE, inside the construction branch — found by this file's own spec.
       *
       * The first draft did `this.client ??= new IORedis(...)` and then called `.on('error')` on the way
       * out, so a listener was added on **every publish**. Node warns at eleven and leaks quietly before
       * that: a busy account would accumulate thousands of identical handlers, and the symptom
       * (`MaxListenersExceededWarning`) appears under load and never in a test.
       *
       * The handler itself is not optional: an unhandled `'error'` on an ioredis client is a
       * process-level crash, and this publisher's entire contract is that it cannot take the service down.
       */
      client.on('error', () => undefined);
      this.client = client;
    }
    return this.client;
  }

  /**
   * Publish one event to its account's channel.
   *
   * ⚠️ **CALL THIS AFTER THE WRITE HAS COMMITTED**, never inside a transaction (FR-004). A client reacts
   * by re-reading; published early, the re-read can arrive before the row is visible and the interface
   * shows *nothing changed* — which is indistinguishable from a broken socket, and therefore the worst
   * available failure. `tests/realtime/every-write-publishes.spec.ts` polices the call sites;
   * `publish-after-commit.spec.ts` polices the ordering.
   *
   * Resolves to `true` when the event was handed to Redis, `false` when it was not (inert or failed) —
   * a return value for tests, never a signal a caller is expected to act on.
   */
  async publish(event: RealtimeEvent): Promise<boolean> {
    const redis = this.connection();
    if (!redis) return false;
    try {
      // The payload is the event, serialized as-is: four identifiers and nothing else (FR-001). There is
      // deliberately no enrichment step here — the moment this method reads a row to "helpfully" add a
      // subject, the socket becomes a read path and inherits every rule the REST projection enforces.
      await redis.publish(realtimeChannel(event.accountId), JSON.stringify(event));
      return true;
    } catch (err) {
      // ⚠️ The CLASS only. Never the event, never the ids: an account id in a log line is tenant data,
      // and there is nothing here a reader could act on that the class does not already tell them.
      this.logger.warn(`realtime publish failed: ${err instanceof Error ? err.constructor.name : 'error'}`);
      return false;
    }
  }

  /** Convenience for the call sites, so no controller hand-assembles a payload shape. */
  conversation(kind: Extract<RealtimeEventKind, `conversation.${string}`>, accountId: string, conversationId: string) {
    return this.publish({ kind, accountId, conversationId });
  }

  message(accountId: string, conversationId: string, messageId: string) {
    return this.publish({ kind: 'message.created', accountId, conversationId, messageId });
  }

  onModuleDestroy(): void {
    this.client?.disconnect();
  }
}
