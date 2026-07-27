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
    },
    env,
  );
}

export type UsersConfig = ReturnType<typeof loadUsersConfig>;
