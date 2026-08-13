/**
 * The closed vocabulary of WHY a password-recovery attempt ended the way it did (W36 / feature 041,
 * roadmap 3.18).
 *
 * ── Why this is a closed set in shared code, and not a string at the call site ────────────────────
 * Because it is the one place the truth exists. The product answers a stranger **identically** whatever
 * happened (FR-001: a form that varies is a directory of who works here), so the difference between «no
 * such address», «that person has no password yet» and «that person may no longer sign in» is visible
 * NOWHERE except in the audit trail. A free-text reason would make the trail unqueryable exactly where it
 * is the only witness — the same argument feature 015 makes for the action catalogue itself.
 *
 * ⚠️ Every member is a CLASS, never a value: no address, no token, no policy text can be expressed here.
 *
 * Pure data. No I/O.
 */

export const RECOVERY_REASONS = [
  // ── request outcomes the requester is never told apart ──
  /** The address belongs to nobody in any account. */
  'unknown_address',
  /** A real person who has never set a password (invited, never registered). */
  'no_password',
  /** A real person who may not sign in — deactivated, offboarded. A leaver must not walk back in. */
  'inactive',
  /** The per-address or per-source limit refused it. Still recorded: volume is the signal. */
  'rate_capped',
  /** A link was issued and the mail was queued. */
  'ok',

  // ── completion refusals ──
  /** Past its TTL. */
  'expired',
  /** Already used once — the single-use property doing its job. */
  'consumed',
  /** Out of attempts: the token is dead rather than grindable. */
  'attempts',
  /** Unknown id, or the right id with the wrong secret. */
  'bad_secret',
  /** The new password failed the policy. WHICH rule is the person's business, not the trail's. */
  'weak_password',
] as const;

export type RecoveryReason = (typeof RECOVERY_REASONS)[number];

/** True only for a member of the vocabulary. Anything else is refused at the write. */
export function isRecoveryReason(value: unknown): value is RecoveryReason {
  return typeof value === 'string' && (RECOVERY_REASONS as readonly string[]).includes(value);
}
