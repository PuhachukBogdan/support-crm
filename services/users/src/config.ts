import { loadConfig, z } from '@crm/common';

/**
 * Required config for the users service (spec 003, US2). Validated at boot — the service
 * refuses to start on any missing/placeholder value (SEC-6). Users domain logic is Phase 3;
 * here it only owns a database (for the health probe) and a gRPC bind address.
 */
export function loadUsersConfig(env: NodeJS.ProcessEnv = process.env) {
  return loadConfig(
    {
      NODE_ENV: z.string().min(1),
      GRPC_URL: z.string().min(1),
      DATABASE_URL: z.string().min(1),
    },
    env,
  );
}

export type UsersConfig = ReturnType<typeof loadUsersConfig>;
