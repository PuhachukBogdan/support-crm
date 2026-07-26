import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from './ports/clock';

/**
 * In-memory sliding-window rate limiter (feature 010, SEC-14 / FR-009 / FR-020). Keyed by an
 * arbitrary string (e.g. `invite:<userId>` or `activate:<email>`). Deterministic under the
 * injectable clock, so Track-A tests can exercise it without wall-clock flakiness.
 *
 * NB: per-instance only. Multi-instance / durable rate-limiting is a later hardening (Redis) —
 * this covers single-instance dev + the low-QPS onboarding/invite flows.
 */
@Injectable()
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /**
   * Record an attempt and report whether it is allowed. Returns false when `key` already has
   * `max` attempts within the trailing `windowSec` seconds (the attempt is NOT recorded then).
   */
  allow(key: string, max: number, windowSec: number): boolean {
    const now = this.clock.now().getTime();
    const cutoff = now - windowSec * 1000;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
