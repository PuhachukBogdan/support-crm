import { createHash } from 'node:crypto';

/**
 * T026 (feature 020, US2) — the evidence cross-brand linking runs on.
 *
 * ── What this stores, and why it is a hash ──────────────────────────────────────────────────────
 * Two player records become one person when they share a real personal identifier — an email or a
 * phone. Matching needs **equality**, and equality does not need the value. So the projection stores
 * a **salted hash** of the normalised value and never the value itself.
 *
 * That is a security requirement, not a preference. A `email_normalized` column would be a NEW PII
 * surface outside the opaque GR8 snapshot: unclassified by the tier policy, uncovered by masking,
 * unknown to exports, and reachable by any log line that prints a row. A hash matches exactly as well
 * and is useless if read.
 *
 * The salt is required at boot (`CONTACT_HASH_SALT`, min 32 chars, no default). An UNSALTED hash of
 * an email is a dictionary lookup away from the address — and a service that booted without one would
 * build a table of recoverable customer contacts while answering every request correctly and keeping
 * every test green. That failure has no symptom, which is why it is refused at startup.
 *
 * ── Normalisation before hashing ────────────────────────────────────────────────────────────────
 * So the same human written two ways still matches, and two humans are never matched by a formatting
 * accident. Deliberately conservative: it corrects presentation, never guesses identity.
 */

export type ContactKind = 'email' | 'phone';

/**
 * Normalise a contact value for comparison, or return null when it is not usable as evidence.
 *
 * - **email** — trimmed and case-folded. Nothing more: stripping dots or `+tags` would merge
 *   addresses that some providers treat as distinct people, which is guessing, not normalising.
 * - **phone** — digits only, keeping a leading `+`. Formatting varies wildly between brands; the
 *   digits do not.
 */
export function normaliseContact(kind: ContactKind, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  if (kind === 'email') {
    const lowered = trimmed.toLowerCase();
    // A value that is not shaped like an address is not evidence about a person.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lowered) ? lowered : null;
  }

  const digits = trimmed.replace(/\D/g, '');
  // Too short to be a real number: a fragment would match many people, which is the opposite of
  // evidence. Seven is the shortest national subscriber number in general use.
  if (digits.length < 7) return null;
  return `+${digits}`;
}

/**
 * Hash a normalised value with the deployment's salt.
 *
 * The kind is part of the input, so an email and a phone that happen to share a string can never
 * collide into a match.
 */
export function hashContact(kind: ContactKind, normalised: string, salt: string): string {
  if (!salt || salt.length < 32) {
    // Defence in depth: config already refuses to boot without it. If this ever throws, something
    // bypassed the config loader — and hashing unsalted would be worse than failing.
    throw new Error('contact hashing requires a salt of at least 32 characters');
  }
  return createHash('sha256').update(`${salt}:${kind}:${normalised}`).digest('hex');
}

/** Normalise then hash. Returns null when the value is not usable as evidence. */
export function contactHash(kind: ContactKind, raw: unknown, salt: string): string | null {
  const normalised = normaliseContact(kind, raw);
  return normalised === null ? null : hashContact(kind, normalised, salt);
}

/**
 * How many records may share one identifier before it stops being evidence about a person.
 *
 * ⚠️ **This guard addresses a different failure from the one the operator accepted.** He judged a
 * relative registering with someone else's email to be a single case that does not matter — taken as
 * given, and one wrong link is correctable because linking copies no data and is reversible.
 *
 * A support-entered placeholder is not that case. `noemail@brand.com`, a branch phone, a repeated
 * dummy — one value across many records — would fuse strangers **in bulk**, systematically, by design
 * of the rule rather than by accident. Two records sharing a value is a person; twenty is a
 * placeholder, and declining it costs nothing.
 */
export const MAX_RECORDS_PER_IDENTIFIER = 2;

/** True when this identifier may establish a link. */
export function isLinkableIdentifier(recordCount: number): boolean {
  return recordCount >= 2 && recordCount <= MAX_RECORDS_PER_IDENTIFIER;
}
