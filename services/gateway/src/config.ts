import { loadConfig, z } from '@crm/common';

/**
 * Required config for the API gateway (spec 003, US2). Validated at boot — refuse to start
 * on any missing/placeholder value (SEC-6). The gateway is the single ingress (REST+WS) and
 * a gRPC CLIENT of every backend service (ping + health fan-out). It owns no database.
 */
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env) {
  return loadConfig(
    {
      NODE_ENV: z.string().min(1),
      GATEWAY_PORT: z.coerce.number().int().positive(),
      REDIS_URL: z.string().min(1),
      AUTH_GRPC_TARGET: z.string().min(1),
      USERS_GRPC_TARGET: z.string().min(1),
      CHATS_GRPC_TARGET: z.string().min(1),
      BRANDS_GRPC_TARGET: z.string().min(1),
      WORKER_GRPC_TARGET: z.string().min(1),
    },
    env,
  );
}

export type GatewayConfig = ReturnType<typeof loadGatewayConfig>;
