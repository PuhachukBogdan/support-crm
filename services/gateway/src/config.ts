import { loadConfig, z } from '@crm/common';

/**
 * Required config for the API gateway. Validated at boot — refuse to start on any
 * missing/placeholder value (SEC-6). The gateway is the single ingress (REST+WS) and a
 * gRPC CLIENT of every backend service. It owns no database.
 *
 * Feature 009: the gateway is the **session edge**. It verifies the access JWT LOCALLY
 * (Principle VII — no per-request gRPC hop), so it needs the SAME `JWT_SECRET` as the auth
 * service. Cookie `Secure` + session lifetimes are tunable; `Secure` defaults ON and is
 * relaxed to off only for local plain-HTTP dev (SEC-7/SEC-11).
 */
export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = loadConfig(
    {
      NODE_ENV: z.string().min(1),
      GATEWAY_PORT: z.coerce.number().int().positive(),
      REDIS_URL: z.string().min(1),
      AUTH_GRPC_TARGET: z.string().min(1),
      USERS_GRPC_TARGET: z.string().min(1),
      CHATS_GRPC_TARGET: z.string().min(1),
      BRANDS_GRPC_TARGET: z.string().min(1),
      WORKER_GRPC_TARGET: z.string().min(1),
      // Shared with the auth service — the guard verifies the access JWT locally. Secret.
      JWT_SECRET: z.string().min(1),
    },
    env,
  );

  const tunables = z
    .object({
      // Cookie maxAge mirrors the token/session lifetimes minted by auth (seconds).
      ACCESS_TTL: z.coerce.number().int().positive().default(900), // 15 min
      SESSION_TTL: z.coerce.number().int().positive().default(86_400), // 1 day
      REMEMBER_TTL: z.coerce.number().int().positive().default(604_800), // 7 days
      // `false` only for local plain-HTTP dev; production is always Secure.
      COOKIE_SECURE: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
    })
    .parse(env);

  return { ...required, ...tunables };
}

export type GatewayConfig = ReturnType<typeof loadGatewayConfig>;

/** Nest DI token carrying the validated {@link GatewayConfig} (provided by the gateway AuthModule). */
export const GATEWAY_CONFIG = Symbol('GATEWAY_CONFIG');
