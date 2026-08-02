/**
 * Normalise a one-time code before it is submitted (feature 027, fix 2026-08-02).
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * The code alphabet is `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — **upper-case letters and digits**, with
 * the ambiguous characters (0/O/1/I) deliberately left out (`services/auth/src/auth/otp.service.ts`).
 * The server compares the submitted string to an argon2 hash **exactly as it arrives**: no trim, no
 * case folding. So a code that is right in every way a person can see — `rfdv8t`, or `RFDV8T ` with
 * a space picked up by copy-paste — is refused, and the screen can only say *"that code is not
 * right"*, because the server will not say which of four reasons it was.
 *
 * That happened on the first real sign-in on the hosted stand: the code was correct and the paste
 * carried a trailing newline.
 *
 * ⚠️ Both transforms are **safe in one direction only, and that is why they are safe at all**: the
 * alphabet contains no lower-case letters and no whitespace, so upper-casing and trimming can turn
 * an invalid string into a valid one but can never turn a valid one into something else.
 *
 * ⚠️ It is done here, in the browser, and NOT on the server. Normalising server-side would widen
 * what the credential check accepts, which is a security decision belonging to whoever owns that
 * check — the same reason feature 027 refused to loosen the deliberate `invalid_code` collapse.
 */
export function normalizeOtpCode(raw: string): string {
  // Every kind of whitespace, not just the ends: a code pasted out of an email can arrive as
  // "RFDV 8T" when a mail client wraps it.
  return raw.replace(/\s+/g, '').toUpperCase();
}
