/**
 * Config loader with refuse-to-start (spec 003-local-infra, US2 / SEC-6 / research D5).
 *
 * Every service validates its required config at boot via `loadConfig(...)`. If any
 * required value is missing, blank, or a known insecure placeholder, it throws
 * `ConfigError` listing ALL offending KEY NAMES (never the values — FR-013 / Principle IV),
 * and the service exits non-zero BEFORE any datastore/gRPC connection is opened. No default
 * credential is ever used.
 */
import { z } from 'zod';

/**
 * Insecure placeholders — treated as "missing" (FR-004.2). Lower-cased on compare.
 * `.env.example` sets every real secret to one of these (e.g. `CHANGE_ME`), so copying
 * the example verbatim fails until the operator fills real values.
 */
export const PLACEHOLDERS: ReadonlySet<string> = new Set([
  '',
  'change_me',
  'changeme',
  'change-me',
  'changthis',
  'password',
  'secret',
  'your-secret-here',
  'placeholder',
  'todo',
  'xxx',
]);

/** Thrown when required config is missing/placeholder. Carries key names only — no values. */
export class ConfigError extends Error {
  constructor(public readonly keys: string[]) {
    super(
      `Refusing to start — missing or placeholder required config: ${keys.join(', ')}. ` +
        `Set real values in .env (see .env.example); no default credentials are used.`,
    );
    this.name = 'ConfigError';
  }
}

function isPlaceholder(value: string | undefined): boolean {
  if (value === undefined) return true;
  const v = value.trim();
  return v === '' || PLACEHOLDERS.has(v.toLowerCase());
}

/**
 * Validate `env` against a zod raw shape. Every key in the shape is treated as required
 * and non-placeholder. Returns the parsed, typed config or throws `ConfigError`.
 */
export function loadConfig<T extends z.ZodRawShape>(
  shape: T,
  env: NodeJS.ProcessEnv = process.env,
): z.infer<z.ZodObject<T>> {
  const keys = Object.keys(shape);

  // 1) Missing / blank / placeholder — the SEC-6 gate. Collect ALL, not just the first.
  const offending = keys.filter((k) => isPlaceholder(env[k]));
  if (offending.length > 0) throw new ConfigError(offending.sort());

  // 2) Type / format validation (never surfaces values — only key paths).
  const parsed = z.object(shape).safeParse(env);
  if (!parsed.success) {
    const bad = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
    throw new ConfigError([...new Set(bad)].sort());
  }
  return parsed.data;
}
