import { loadConfig, z } from '@crm/common';

/**
 * Required config for the chats service (spec 003, US2). Validated at boot — the service
 * refuses to start on any missing/placeholder value (SEC-6).
 *
 * `AUTH_GRPC_TARGET` (feature 014): an automation rule acts with its author's CURRENT permissions,
 * resolved from auth on every evaluation (FR-023). Without that dial target every rule would refuse
 * (fail-closed, FR-024) — which is safe but useless, so it is a boot requirement rather than a
 * runtime surprise.
 */
export function loadChatsConfig(env: NodeJS.ProcessEnv = process.env) {
  return loadConfig(
    {
      NODE_ENV: z.string().min(1),
      GRPC_URL: z.string().min(1),
      DATABASE_URL: z.string().min(1),
      AUTH_GRPC_TARGET: z.string().min(1),
    },
    env,
  );
}

export type ChatsConfig = ReturnType<typeof loadChatsConfig>;
