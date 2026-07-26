import { ConfigError } from '@crm/common';
import { loadWorkerConfig } from './config';

/**
 * T008 (feature 014) — the worker's config gate for its first real job.
 * FAILS before CHATS_GRPC_TARGET / the sweep knobs exist, PASSES after.
 *
 * Two properties worth a test rather than trust:
 *  1. A worker that cannot reach chats must refuse to BOOT. A silently non-sweeping worker is the
 *     worst failure mode this feature can have — a breach is something nobody is waiting for, so no
 *     request 500s, no user complains, and the SLA simply never fires (FR-014).
 *  2. The sweep interval is a tuning knob, not a secret: garbage must be clamped, never crash and
 *     never become a hot loop against chats.
 */
const BASE = {
  NODE_ENV: 'test',
  GRPC_URL: '0.0.0.0:50055',
  REDIS_URL: 'redis://redis:6379',
  CHATS_GRPC_TARGET: 'chats:50053',
} as NodeJS.ProcessEnv;

describe('loadWorkerConfig — feature 014', () => {
  it('accepts a complete env and exposes the documented defaults', () => {
    const cfg = loadWorkerConfig({ ...BASE });
    expect(cfg.CHATS_GRPC_TARGET).toBe('chats:50053');
    expect(cfg.SLA_SWEEP_INTERVAL_MS).toBe(30_000);
    expect(cfg.SLA_SWEEP_BATCH).toBe(500);
  });

  it('REFUSES to start without CHATS_GRPC_TARGET (a worker that cannot sweep must not pretend to)', () => {
    const env = { ...BASE };
    delete env.CHATS_GRPC_TARGET;
    expect(() => loadWorkerConfig(env)).toThrow(ConfigError);
  });

  it('still refuses on the pre-existing required keys', () => {
    for (const key of ['NODE_ENV', 'GRPC_URL', 'REDIS_URL'] as const) {
      const env = { ...BASE };
      delete env[key];
      expect(() => loadWorkerConfig(env)).toThrow(ConfigError);
    }
  });

  it('names the offending KEY and never a value (Principle IV)', () => {
    const env = { ...BASE };
    delete env.CHATS_GRPC_TARGET;
    try {
      loadWorkerConfig(env);
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as ConfigError).message;
      expect(msg).toContain('CHATS_GRPC_TARGET');
      expect(msg).not.toContain('redis://redis:6379');
    }
  });

  it.each([
    ['0', 1_000],
    ['-5', 1_000],
    ['500', 1_000], // below the floor
    ['abc', 30_000], // unparseable ⇒ documented default
    ['', 30_000],
    ['5000', 5_000], // honoured (Track B uses a short interval)
    ['99999999', 3_600_000], // above the ceiling
  ])('clamps SLA_SWEEP_INTERVAL_MS %p to %p (never a hot loop)', (raw, expected) => {
    expect(loadWorkerConfig({ ...BASE, SLA_SWEEP_INTERVAL_MS: raw }).SLA_SWEEP_INTERVAL_MS).toBe(
      expected,
    );
  });

  it.each([
    ['0', 1],
    ['-1', 1],
    ['nope', 500],
    ['250', 250],
    ['1000000', 5_000], // one tick can never scan the world
  ])('clamps SLA_SWEEP_BATCH %p to %p', (raw, expected) => {
    expect(loadWorkerConfig({ ...BASE, SLA_SWEEP_BATCH: raw }).SLA_SWEEP_BATCH).toBe(expected);
  });
});
