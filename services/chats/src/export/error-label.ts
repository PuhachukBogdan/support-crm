import { AuditDetailError, AuditEntryError } from '@crm/common';
import { AuthorityUnavailableError } from '../auth/auth.client';
import { UploadsUnavailableError } from '../uploads/uploads.client';
import { ByteLimitExceededError, RowLimitExceededError } from './export.producer';

/**
 * How an export failure is written to a log line (feature 017, T055 — SEC-26 / Principle IV).
 *
 * ── The problem this solves, found by writing the no-PII test ─────────────────────────────────────
 * The failure handler logged `err.name: err.message` for **any** error, because feature 014's live
 * lesson was that a bare class name made a failing sweep undiagnosable. That is the right lesson and
 * the wrong conclusion here, for a reason specific to this feature: the producer runs a filtered query
 * whose filter values ARE the sensitive part (a player id, a brand, an assignee). A Prisma error, a
 * driver error or a validation error can echo the query arguments into its message — so "log the
 * message" quietly means "log the filters" on exactly the path where something has gone wrong and
 * somebody is about to read the logs.
 *
 * ── The rule ─────────────────────────────────────────────────────────────────────────────────────
 * A MESSAGE is logged only for error classes **this product defines**, whose messages are fixed strings
 * we wrote. Everything else contributes its class NAME and nothing more. That keeps 014's
 * diagnosability for the failures this feature actually produces — caps, storage, authority, audit —
 * while making a third-party error's payload structurally unable to reach a log line.
 *
 * An allow-list, in other words: the same discipline as the audit detail keys, the upload purposes, the
 * automation vocabulary and the export scopes. "Be careful what you log" is a code-review rule, and
 * code-review rules hold until the third feature adds a `catch` under a deadline.
 */
/**
 * The classes whose messages we wrote and may therefore print.
 *
 * Exactly the errors that can reach a LOG line — i.e. the ones raised during production, inside the
 * `run` handler. `UnknownScopeError`, `ExportForbiddenError` and `QuotaExhaustedError` are deliberately
 * absent: they are REQUEST-path refusals that propagate to the gRPC controller and become statuses, and
 * nothing logs them. Listing them would have been harmless-looking dead weight — and it also created an
 * import cycle with `export.service.ts` that only failed at module-initialisation time, which is how it
 * was noticed.
 */
const MESSAGE_SAFE_ERRORS = [
  RowLimitExceededError,
  ByteLimitExceededError,
  UploadsUnavailableError,
  AuthorityUnavailableError,
  AuditEntryError,
  AuditDetailError,
] as const;

/** First line only, capped — a stack trace in a log line is a second way for a value to escape. */
function firstLine(message: string): string {
  return (message.split('\n')[0] ?? '').slice(0, 200);
}

/**
 * A log-safe label for `err`.
 *
 * `ObjectStoreError` and the gRPC status objects are deliberately NOT on the allow-list: the former is
 * raised in `users` and reaches here only as a gRPC status, and a status's `message`/`details` are
 * whatever the peer put there.
 */
export function errorLabel(err: unknown): string {
  if (!(err instanceof Error)) {
    // A thrown gRPC status object: `{ code, message }`. The CODE is ours to report; the message is not.
    const code = (err as { code?: number })?.code;
    return typeof code === 'number' ? `rpc(${code})` : 'error';
  }
  const safe = MESSAGE_SAFE_ERRORS.some((cls) => err instanceof cls);
  return safe ? `${err.name}: ${firstLine(err.message)}` : err.name;
}
