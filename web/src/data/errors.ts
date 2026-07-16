import type { DataError } from './types';

const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

/** Type guard: already a sanitized DataError. */
export function isDataError(v: unknown): v is DataError {
  return (
    typeof v === 'object' &&
    v !== null &&
    'message' in v &&
    'retryable' in v &&
    typeof (v as DataError).message === 'string'
  );
}

/**
 * Normalize ANY thrown value into a sanitized DataError (FR-005 / Principle IV).
 * A pre-built DataError passes through; anything else collapses to a generic message so
 * raw transport bodies, tokens, URLs, or PII can never reach the UI or logs.
 */
export function toDataError(err: unknown): DataError {
  if (isDataError(err)) return err;
  const code = err instanceof Error && err.name ? err.name : undefined;
  return { message: GENERIC_MESSAGE, retryable: true, code };
}
