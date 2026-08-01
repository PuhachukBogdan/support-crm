import { loadConfig, z } from '@crm/common';

/**
 * Required config for the users service (spec 003, US2). Validated at boot — the service
 * refuses to start on any missing/placeholder value (SEC-6). Users domain logic is Phase 3;
 * here it only owns a database (for the health probe) and a gRPC bind address.
 *
 * ── The S3_* block (feature 016, roadmap 4.9 — research R2/R10) ──────────────────────────
 * `users` is the ONLY service that reaches the object store, so it is the only service that
 * declares these keys. **The gateway gains nothing**, and that absence is deliberate: it is
 * the observable form of credential containment — a reviewer can see the property in the
 * config schemas without reading a line of upload code, and
 * `tests/uploads/single-ingest-path.spec.ts` fails if a second service starts declaring them.
 *
 * Required rather than optional: an upload path that boots without a store would accept a
 * request and fail at the write, after the caller believes the file was taken. Refusing to
 * start is the honest failure (SEC-6). The error names the KEY only — never the value.
 */
export function loadUsersConfig(env: NodeJS.ProcessEnv = process.env) {
  return loadConfig(
    {
      NODE_ENV: z.string().min(1),
      GRPC_URL: z.string().min(1),
      DATABASE_URL: z.string().min(1),
      S3_ENDPOINT: z.string().min(1),
      S3_REGION: z.string().min(1),
      S3_BUCKET: z.string().min(1),
      S3_ACCESS_KEY_ID: z.string().min(1),
      S3_SECRET_ACCESS_KEY: z.string().min(1),
      S3_FORCE_PATH_STYLE: z.string().min(1),
      /**
       * Salt for the contact-match hashes (feature 020, roadmap 5.2 / data-model I-7).
       *
       * REQUIRED, with no default, and that is the whole point. Cross-brand player linking
       * compares a hash of a normalised email or phone; an UNSALTED hash of an email is
       * reversible by dictionary in seconds, so a service that booted without a salt would
       * quietly build a table of recoverable customer contacts and every test would stay green.
       * Refusing to start is the honest failure (SEC-6), exactly as for the S3 block above.
       *
       * 32 chars minimum so a placeholder like "salt" cannot satisfy it.
       */
      CONTACT_HASH_SALT: z.string().min(32),

      /**
       * ── Feature 025 (roadmap 5.9) — when a quiet session stops being treated as available.
       *
       * Both are measured from **last activity**, not from entering the previous state, so a long
       * outage moves somebody straight to `offline` in one step and writes one transition per state
       * actually entered — not one per elapsed interval.
       *
       * 🅿 **PROVISIONAL.** There is no authoritative number yet: ADR 0042 open item 1 records the
       * "status timeout" as belonging here once auto-away exists, and it was never specified.
       * **Revised by:** the operations team's real numbers. The mark travels with the value into
       * `compose.yaml`, `.env.example` and the seed — a provisional decision is in force, but must
       * never be presented as settled.
       *
       * Required, with no default, for the reason the whole block above is: a service that booted
       * without them would run a sweep on a made-up threshold and quietly put people offline (or
       * never do so at all), and every test would stay green. Refusing to start is the honest
       * failure (SEC-6). ⚠️ `loadConfig` checks PRESENCE before zod runs, so a `.default()` here
       * would be unreachable — do not add one believing it protects anything.
       */
      PRESENCE_AWAY_AFTER_SECONDS: z.coerce.number().int().positive(),
      PRESENCE_OFFLINE_AFTER_SECONDS: z.coerce.number().int().positive(),
    },
    env,
  );
}

export type UsersConfig = ReturnType<typeof loadUsersConfig>;
