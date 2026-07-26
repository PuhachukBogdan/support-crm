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
  };
}

/** Parse an integer env value; fall back when unparseable, clamp into [min, max]. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
