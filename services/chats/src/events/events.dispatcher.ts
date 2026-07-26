import { Injectable, Logger } from '@nestjs/common';
import type { DomainEvent } from './events.types';

/** A subscriber. Returns the number of rules it applied (for the sweep's `rules_applied` count). */
export type DomainEventHandler = (event: DomainEvent) => Promise<number>;

/**
 * Synchronous in-process dispatcher (feature 014, research R4).
 *
 * Only **controllers** may publish (see `events.types.ts` for why, and
 * `no-publish-from-repositories.spec.ts` for the guard). Delivery is awaited rather than
 * fire-and-forget so that a rule's effect is observable by the time the triggering call returns —
 * Track B asserts exactly that, and an async queue here would make "did the rule run?" untestable
 * without polling.
 *
 * A subscriber that throws is logged and swallowed: an automation is a *reaction*, and a broken rule
 * must never fail the human action that triggered it (posting a message must not 500 because a rule
 * misfired). The failure is still recorded per rule in `AutomationRun` by the engine itself, so it is
 * visible where it belongs rather than in a stack trace.
 */
@Injectable()
export class DomainEventDispatcher {
  private readonly logger = new Logger(DomainEventDispatcher.name);
  private readonly handlers: DomainEventHandler[] = [];

  subscribe(handler: DomainEventHandler): void {
    this.handlers.push(handler);
  }

  /** Publish an event; resolves to the total number of rule applications across subscribers. */
  async publish(event: DomainEvent): Promise<number> {
    let applied = 0;
    for (const handler of this.handlers) {
      try {
        applied += await handler(event);
      } catch (err) {
        // Trigger + conversation id only — never facts, never message text (Principle IV / SEC-26).
        this.logger.warn(
          `automation dispatch failed for ${event.trigger} on conversation ${event.conversationId}: ` +
            `${err instanceof Error ? err.name : 'error'}`,
        );
      }
    }
    return applied;
  }
}
