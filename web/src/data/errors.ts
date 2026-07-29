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

/**
 * T006 — failure classification for the gateway transport (feature 019, research R5).
 *
 * ── The guarantee is held by never READING the body, not by trusting it to be clean ─────────────
 * The gateway already answers with the class of failure and no downstream detail. This layer does
 * not rely on that: it maps a STATUS to a fixed message and never touches the response body. That
 * distinction is the 5.1 lesson — a guarantee whose real mechanism is mis-stated is one refactor
 * away from being gone, silently, with every test still green. Here the mechanism is that no code
 * path exists from a body to a message.
 *
 * `refused` and `not-found` stay deliberately coarse: 403 covers both a missing permission and a
 * tier refusal, and 404 covers both "unknown" and "belongs to another account" (isolation, SEC-17).
 * Distinguishing them client-side would re-create the disclosure the server refused to make.
 */
export type FailureClass =
  | 'invalid-request'
  | 'no-session'
  | 'refused'
  | 'not-found'
  | 'unavailable';

/** Fixed text per class. Never interpolated, never derived from a response. */
const CLASS_MESSAGE: Record<FailureClass, string> = {
  'invalid-request': 'The request was not valid.',
  'no-session': 'Your session has ended. Please sign in again.',
  refused: 'You do not have access to this.',
  'not-found': 'Not found.',
  unavailable: GENERIC_MESSAGE,
};

/** Only an unavailable service is worth retrying; every other class would fail identically. */
const CLASS_RETRYABLE: Record<FailureClass, boolean> = {
  'invalid-request': false,
  'no-session': false,
  refused: false,
  'not-found': false,
  unavailable: true,
};

/** HTTP status → class. Status 0 is this codebase's "the request never completed". */
export function classifyStatus(status: number): FailureClass {
  switch (status) {
    case 400:
      return 'invalid-request';
    case 401:
      return 'no-session';
    case 403:
      return 'refused';
    case 404:
      return 'not-found';
    default:
      return 'unavailable';
  }
}

/** Build the sanitized error for a class. The `code` is the class, which carries no request detail. */
export function dataErrorFor(cls: FailureClass): DataError {
  return { message: CLASS_MESSAGE[cls], retryable: CLASS_RETRYABLE[cls], code: cls };
}

/** Convenience: status straight to a sanitized error, with no body involved at any point. */
export function dataErrorForStatus(status: number): DataError {
  return dataErrorFor(classifyStatus(status));
}

/**
 * A client-side refusal — the request was never sent. Its message names the offending PARAMETER
 * and never its value, following `services/gateway/src/players/wire.ts`: a query value can be a
 * customer identifier.
 */
export function clientRefusal(reason: string): DataError {
  return { message: reason, retryable: false, code: 'invalid-request' };
}
