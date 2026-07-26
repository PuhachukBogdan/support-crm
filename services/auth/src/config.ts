import { loadConfig, z } from '@crm/common';

/**
 * Required config for the auth service. Validated at boot — the service refuses to start on
 * any missing/placeholder value (SEC-6). Feature 009 adds the auth engine's knobs.
 *
 * Two tiers:
 *  - **Required + refuse-to-start** (secrets / connection): `JWT_SECRET`, `GRPC_URL`,
 *    `DATABASE_URL`, `NODE_ENV`. A missing/placeholder `JWT_SECRET` MUST stop the process.
 *  - **Tunables with safe defaults** (TTLs, code/lockout params, argon2 cost): parsed with
 *    `.default(...)` so an operator need not set ten env vars to boot, but every one is still
 *    overridable via `.env`. Values are seconds unless noted.
 *
 * NB (analyze U1): the set-time **password policy** + its config land in feature 010 (this feature
 * had no password-set surface). Feature 010 adds `PASSWORD_MIN_LENGTH` + class-requirement knobs,
 * the invite TTL, and the invite / onboarding-request rate knobs below.
 */
export function loadAuthConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = loadConfig(
    {
      NODE_ENV: z.string().min(1),
      GRPC_URL: z.string().min(1),
      DATABASE_URL: z.string().min(1),
      // Signing key for the access JWT (shared with the gateway for local verify). Secret.
      JWT_SECRET: z.string().min(1),
    },
    env,
  );

  // Tunables — safe defaults, all overridable. Not part of the refuse-to-start gate.
  const tunables = z
    .object({
      ACCESS_TTL: z.coerce.number().int().positive().default(900), // 15 min
      SESSION_TTL: z.coerce.number().int().positive().default(86_400), // 1 day
      REMEMBER_TTL: z.coerce.number().int().positive().default(604_800), // 7 days
      CODE_TTL: z.coerce.number().int().positive().default(600), // 10 min
      CODE_LENGTH: z.coerce.number().int().min(4).max(12).default(6),
      CODE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
      LOCKOUT_THRESHOLD: z.coerce.number().int().positive().default(5),
      LOCKOUT_WINDOW: z.coerce.number().int().positive().default(900), // 15 min
      ARGON2_MEMORY_COST: z.coerce.number().int().positive().default(19_456), // 19 MiB
      ARGON2_TIME_COST: z.coerce.number().int().positive().default(2),
      // Feature 010 — set-time password policy (analyze U1). Configurable per FR-015.
      PASSWORD_MIN_LENGTH: z.coerce.number().int().min(1).default(6),
      PASSWORD_REQUIRE_UPPERCASE: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
      PASSWORD_REQUIRE_DIGIT: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
      PASSWORD_REQUIRE_SYMBOL: z
        .enum(['true', 'false'])
        .default('true')
        .transform((v) => v === 'true'),
      // Feature 010 — invitation lifetime + rate limits (SEC-5 / SEC-14).
      INVITE_TTL: z.coerce.number().int().positive().default(86_400), // 24h
      INVITE_RATE_MAX: z.coerce.number().int().positive().default(20),
      INVITE_RATE_WINDOW: z.coerce.number().int().positive().default(3_600), // 1h
      ONBOARD_REQUEST_RATE_MAX: z.coerce.number().int().positive().default(5),
      ONBOARD_REQUEST_RATE_WINDOW: z.coerce.number().int().positive().default(900), // 15m
    })
    .parse(env);

  return { ...required, ...tunables };
}

export type AuthConfig = ReturnType<typeof loadAuthConfig>;

/** Nest DI token carrying the validated {@link AuthConfig} (provided by AuthModule). */
export const AUTH_CONFIG = Symbol('AUTH_CONFIG');
