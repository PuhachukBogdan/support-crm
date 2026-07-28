import { loadConfig, z } from '@crm/common';

/**
 * Required config for the worker service (spec 003, US2). Validated at boot — refuse to
 * start on missing/placeholder values (SEC-6). The worker owns no relational database; it
 * connects to Redis (via BullMQ) and exposes a gRPC health surface.
 *
 * Feature 014 gives it its first real job — the first-reply SLA sweep (roadmap 4.7). Its role there
 * is scheduling ONLY: fire a repeatable tick, call the chats maintenance RPC. It holds no rule state
 * and makes no decisions; chats owns the data and the verdict (research R1/R2).
 *
 * `CHATS_GRPC_TARGET` is therefore REQUIRED: a worker that cannot reach chats cannot sweep, and
 * failing loudly at boot beats a silently non-sweeping worker — nobody is waiting on a breach, so
 * nothing else in the system would ever notice.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = loadConfig(
    {
      NODE_ENV: z.string().min(1),
      GRPC_URL: z.string().min(1),
      REDIS_URL: z.string().min(1),
      CHATS_GRPC_TARGET: z.string().min(1),
      // Feature 017 (roadmap 4.10): the worker also ticks the artefact purge, and `users` owns the
      // storage credentials and therefore the deletion. REQUIRED for the same reason as chats above:
      // a worker that cannot reach users cannot purge, and an export artefact that is never purged is
      // a PII copy outliving its authorization (SEC-27). Failing loudly at boot beats a silently
      // non-purging worker, because nobody is waiting on a deletion either.
      USERS_GRPC_TARGET: z.string().min(1),
    },
    env,
  );

  return {
    ...required,
    // Tuning knobs, not secrets: absent ⇒ documented default; nonsense ⇒ clamped rather than a
    // refusal to boot. Detection latency is bounded by the interval by design (research R2), so a
    // 0 / negative / non-numeric value must never become a hot loop.
    SLA_SWEEP_INTERVAL_MS: clampInt(env.SLA_SWEEP_INTERVAL_MS, 30_000, 1_000, 3_600_000),
    SLA_SWEEP_BATCH: clampInt(env.SLA_SWEEP_BATCH, 500, 1, 5_000),
    // Feature 017. The export tick is the queue: a `queued` row waits at most one interval, which is
    // why 10 s (not 30) — an export is something a person is actively waiting for, unlike a breach.
    EXPORT_RUN_INTERVAL_MS: clampInt(env.EXPORT_RUN_INTERVAL_MS, 10_000, 1_000, 3_600_000),
    EXPORT_RUN_BATCH: clampInt(env.EXPORT_RUN_BATCH, 5, 1, 100),
    // The purge is not time-critical — an artefact one interval past its 24 h is not a new risk — so
    // this ticks slowly and in larger batches.
    ARTEFACT_PURGE_INTERVAL_MS: clampInt(env.ARTEFACT_PURGE_INTERVAL_MS, 300_000, 1_000, 3_600_000),
    ARTEFACT_PURGE_BATCH: clampInt(env.ARTEFACT_PURGE_BATCH, 100, 1, 1_000),
  };
}

/** Parse an integer env value; fall back when unparseable, clamp into [min, max]. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
