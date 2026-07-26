/**
 * Injectable clock (feature 009, research R8). Every expiry/lockout decision reads time from
 * here so specs can drive it deterministically (a fixed/advanceable clock) instead of sleeping.
 * Production uses {@link SystemClock}.
 */
export interface Clock {
  now(): Date;
}

/** Nest DI token for the clock. */
export const CLOCK = Symbol('CLOCK');

/** Real wall-clock — the production binding. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * Test clock — starts at a fixed instant and only moves when told. Exported for reuse across
 * the auth specs (otp/refresh/lockout expiry). Not wired in production.
 */
export class FixedClock implements Clock {
  constructor(private current: Date = new Date('2026-07-21T00:00:00.000Z')) {}
  now(): Date {
    return this.current;
  }
  set(at: Date): void {
    this.current = at;
  }
  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}
