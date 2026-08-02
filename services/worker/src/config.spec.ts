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
  // Feature 017 (roadmap 4.10): the worker also ticks the artefact purge, and `users` owns the
  // storage credentials and therefore the deletion.
  USERS_GRPC_TARGET: 'users:50052',
  // Feature 028 — the mail sweep's target.
  AUTH_GRPC_TARGET: 'auth:50051',
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

  it('REFUSES to start without USERS_GRPC_TARGET (a worker that cannot purge must not pretend to)', () => {
    // Feature 017. Same reasoning as the chats target above, and the consequence is the one SEC-27
    // names: an export artefact that is never purged is a PII copy outliving its authorization. A
    // silently non-purging worker produces no error anywhere — the bytes just stay.
    const env = { ...BASE };
    delete env.USERS_GRPC_TARGET;
    expect(() => loadWorkerConfig(env)).toThrow(ConfigError);
  });

  it('exposes the export/purge tick defaults, and clamps garbage rather than crashing', () => {
    const cfg = loadWorkerConfig({ ...BASE });
    // The export tick IS the queue (chats has no Redis — research R3), so it is faster than the SLA
    // sweep: someone is actively waiting for an export, unlike a breach.
    expect(cfg.EXPORT_RUN_INTERVAL_MS).toBe(10_000);
    expect(cfg.EXPORT_RUN_BATCH).toBe(5);
    expect(cfg.ARTEFACT_PURGE_INTERVAL_MS).toBe(300_000);
    expect(cfg.ARTEFACT_PURGE_BATCH).toBe(100);

    const clamped = loadWorkerConfig({
      ...BASE,
      EXPORT_RUN_INTERVAL_MS: '0',
      EXPORT_RUN_BATCH: 'nonsense',
      ARTEFACT_PURGE_BATCH: '99999',
    });
    expect(clamped.EXPORT_RUN_INTERVAL_MS).toBe(1_000); // never a hot loop
    expect(clamped.EXPORT_RUN_BATCH).toBe(5); // unparseable ⇒ documented default
    expect(clamped.ARTEFACT_PURGE_BATCH).toBe(1_000); // clamped to the ceiling
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
