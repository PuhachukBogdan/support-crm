import { loadConfig, z } from '@crm/common';

/**
 * Required config for the worker service (spec 003, US2). Validated at boot — refuse to
 * start on missing/placeholder values (SEC-6). The worker owns no relational database; it
 * connects to Redis (via BullMQ) and exposes a gRPC health surface. Real jobs = Phase 7.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  return loadConfig(
    {
      NODE_ENV: z.string().min(1),
      GRPC_URL: z.string().min(1),
      REDIS_URL: z.string().min(1),
    },
    env,
  );
}

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;
