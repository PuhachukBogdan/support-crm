import { ConfigError, loadConfig, z } from '@crm/common';
import { CODE_ALPHABET_RE } from './auth/code-alphabet';

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
      // ── The FIXED sign-in code — a stand convenience, and a hole if it ever escapes ──────────
      //
      // Named `DEV_` so the name itself is the warning. Empty (the default) = off, which is every
      // deployment that does not deliberately set it. See `assertFixedLoginCodeUsable` below for
      // the four ways it refuses to start rather than misbehave quietly.
      DEV_FIXED_LOGIN_CODE: z.string().default(''),
      /** Comma-separated addresses the fixed code applies to. Empty = the feature is off. */
      DEV_FIXED_LOGIN_CODE_EMAILS: z.string().default(''),
    })
    .parse(env);

  const cfg = { ...required, ...tunables };
  assertFixedLoginCodeUsable(cfg);
  return cfg;
}

/** Parse the fixed-code allow-list — trimmed, lower-cased, empties dropped. Empty = feature off. */
export function parseFixedLoginCodeEmails(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Normalise a configured fixed code the way the BROWSER normalises a typed one
 * (`web/src/lib/otp-code.ts`): strip every whitespace, upper-case. Without this, a code written in
 * `.env` as `abc 234` is submitted by the browser as `ABC234` and refused by a server comparing
 * against the literal — correct in every way a person can see, and wrong.
 */
export function normalizeFixedLoginCode(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/**
 * The gate on the fixed code. ⚠️ **Every branch here is refuse-to-start, on purpose.**
 *
 * This knob's whole failure mode is silence: it is set by somebody who then stops watching, and
 * every way it can be wrong looks identical from the outside — the person types the code they
 * configured and is told it is not right, with no way to tell a typo from a knob that never applied.
 * A crash at boot, naming the key, is the only symptom this feature can have.
 *
 * ⛔ And the one that is not about convenience: **it refuses to run under `NODE_ENV=production`.**
 * A fixed code is a permanent password for the second factor; the security gate (rule 5) says no
 * real data enters this system until the P0 findings are closed, and this knob must not be what
 * survives into the deployment that holds it. Deleting the two variables is how it is turned off.
 */
function assertFixedLoginCodeUsable(cfg: {
  NODE_ENV: string;
  CODE_LENGTH: number;
  DEV_FIXED_LOGIN_CODE: string;
  DEV_FIXED_LOGIN_CODE_EMAILS: string;
}): void {
  const code = normalizeFixedLoginCode(cfg.DEV_FIXED_LOGIN_CODE);
  const emails = parseFixedLoginCodeEmails(cfg.DEV_FIXED_LOGIN_CODE_EMAILS);
  if (code === '' && emails.length === 0) return; // off — the default everywhere

  const bad: string[] = [];
  // Half-configured in either direction is the silent case: one variable set, nothing happens.
  if (code === '') bad.push('DEV_FIXED_LOGIN_CODE');
  if (emails.length === 0) bad.push('DEV_FIXED_LOGIN_CODE_EMAILS');
  // A character the generator never emits is refused by the server and looks fine in `.env`.
  if (code !== '' && !CODE_ALPHABET_RE.test(code)) bad.push('DEV_FIXED_LOGIN_CODE');
  // A different length than the product's: the sign-in field is sized to CODE_LENGTH, so a short
  // code cannot be finished and a long one cannot be typed at all.
  if (code !== '' && code.length !== cfg.CODE_LENGTH) bad.push('DEV_FIXED_LOGIN_CODE');
  if (cfg.NODE_ENV === 'production') bad.push('DEV_FIXED_LOGIN_CODE (not allowed in production)');

  // ⚠️ Key names only — never the code itself. ConfigError is read out of a crash log.
  if (bad.length > 0) throw new ConfigError([...new Set(bad)].sort());
}

/**
 * ⚠️ **MOVED** to `libs/common/src/mail/guards.ts` (feature 033, research R7) and re-exported here.
 *
 * It moved because feature 033 added a second mail sender and the guard had to become one boundary
 * rather than two implementations. Re-exported rather than relocated in-place because `config.spec.ts`
 * imports it from this path and is the proof the behaviour did not change — that test passes unmodified.
 *
 * ⚠️ **Empty means UNRESTRICTED, not "send nothing".** Read the other way round it would silently stop
 * all mail in production, where an empty list is the legitimate configuration — and a mail system that
 * sends nothing looks exactly like one that is merely slow.
 */
export { parseAllowedRecipientDomains } from '@crm/common';

export type AuthConfig = ReturnType<typeof loadAuthConfig>;

/** Nest DI token carrying the validated {@link AuthConfig} (provided by AuthModule). */
export const AUTH_CONFIG = Symbol('AUTH_CONFIG');
