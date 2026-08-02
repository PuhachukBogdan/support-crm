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
      // ── Feature 028 — mail. Three keys join the refuse-to-start tier ────────────────────────
      // A service that boots without these answers every login perfectly and delivers nothing:
      // the person is told a code was sent, waits, and concludes the product is broken, while
      // every health check stays green.
      //
      // ⚠️ `APP_BASE_URL` has NO default on purpose. A guessed `http://localhost:3001` would email
      // invitations that look perfect and lead nowhere — the very defect (roadmap 8.6 / T033) this
      // feature closes, in better camouflage.
      MAIL_HOST: z.string().min(1),
      MAIL_FROM: z.string().min(1),
      APP_BASE_URL: z.string().url(),
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
      // Feature 028 — mail tunables. The defaults describe the DEVELOPMENT transport (a local
      // catcher on 1025, no credentials, no TLS), because that is the transport local development
      // and every live test round use (research R5). A real relay overrides four values.
      MAIL_PORT: z.coerce.number().int().positive().default(1025),
      // ⚠️ EMPTY STRING means absent, not "a credential of length zero". Compose passes unset
      // optional variables as `''` (`${MAIL_USER:-}`), and `.optional()` only fires on `undefined`
      // — so a plain `.min(1).optional()` made the service REFUSE TO START against a catcher that
      // needs no credentials. Found by the first live boot on 2026-08-02, which is the only place
      // it could be found: nothing in a unit test hands a variable through compose.
      MAIL_USER: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
      MAIL_PASSWORD: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
      MAIL_SECURE: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
      /** The name shown in the messages. ⚠️ Neutral by default — a licensee's staff must never
       *  receive OUR name in their authentication mail (Principle VI, FR-009). */
      MAIL_BRAND_NAME: z.string().min(1).default('Support CRM'),
      /** Comma-separated. Empty = unrestricted, which is legitimate only in production (FR-019). */
      MAIL_ALLOWED_RECIPIENT_DOMAINS: z.string().default(''),
      MAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
      MAIL_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(15_000),
    })
    .parse(env);

  return { ...required, ...tunables };
}

/**
 * Parse the recipient allow-list (FR-018/FR-019).
 *
 * ⚠️ **Empty means UNRESTRICTED, not "send nothing".** Read the other way round it would silently
 * stop all mail in production, where an empty list is the legitimate configuration — and a mail
 * system that sends nothing looks exactly like one that is merely slow.
 *
 * A leading `@` is accepted because that is how somebody writing down a domain will type it.
 */
export function parseAllowedRecipientDomains(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => d.length > 0);
}

export type AuthConfig = ReturnType<typeof loadAuthConfig>;

/** Nest DI token carrying the validated {@link AuthConfig} (provided by AuthModule). */
export const AUTH_CONFIG = Symbol('AUTH_CONFIG');
