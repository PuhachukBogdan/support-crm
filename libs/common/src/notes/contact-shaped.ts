/**
 * Contact-shaped text in a free-text note (W35 / feature 040 — R35, U17).
 *
 * ── What this is for ────────────────────────────────────────────────────────────────────────────────
 * A player note is the one place in the product where a person types prose about a customer, and
 * therefore the one place where field-level masking can be walked around: the phone number is withheld
 * from the card by tier (SEC-AP1), and nothing stops an author typing it into a note that everyone with
 * the tier reads. R35 named that as the bypass; U17 decided the response — **warn the author and record
 * the event, do not block** — because a block is defeated in two seconds (*«телефон: восемь девять
 * два…»*) and pushes the behaviour into text no detector can see. The warning keeps both the deterrent
 * and the evidence.
 *
 * ── ⚠️ Why this is NOT `looksLikePersonalData` from `../audit/detail.ts` ────────────────────────────
 * Same subject, **opposite constraint**, and the difference is load-bearing rather than stylistic:
 *
 * | | `looksLikePersonalData` | this |
 * |---|---|---|
 * | input | one audit-detail VALUE (an identifier or an enum token) | PROSE somebody typed |
 * | consequence of firing | the write is **REFUSED** | the author sees a **warning** |
 * | therefore | must never fire on our own ids ⇒ matches the value as a WHOLE | may fire generously ⇒ searches INSIDE |
 *
 * Its own comment states the trap it was corrected out of: *"a PII check that refuses valid writes is
 * worse than none, because it gets relaxed rather than fixed"*. That is true of a **gate**. Here the
 * cost of a false positive is one click, and the cost of a miss is a customer's phone number sitting in
 * readable free text — so this one is deliberately the generous of the two. Reusing that function here
 * would have imported a conservatism built for the opposite trade-off.
 *
 * ── The bound on what it can promise ───────────────────────────────────────────────────────────────
 * It recognises SHAPES, not intent. Spelled-out digits, a number split across lines, a handle without
 * an `@` — all pass, and U17 already accepted that: the point is not a wall, it is that the ordinary
 * way of writing a phone number is noticed and recorded. Anything stronger would be a claim this
 * function cannot keep.
 *
 * Pure: no I/O, no clock, no state. Runs on the SERVER only — `web/` imports nothing from this library
 * by standing rule, and a browser-side copy would be a second implementation of a security rule (the
 * divergence-with-a-delay-fuse `single-policy-path.spec.ts` exists to prevent). The warning the author
 * sees is therefore this function's answer, travelled back — which is also the only version a client
 * cannot skip.
 */

/** The closed vocabulary. Stored on the note row and named in the audit entry — never a matched value. */
export const CONTACT_PATTERN_KINDS = ['email', 'handle', 'phone'] as const;

export type ContactPatternKind = (typeof CONTACT_PATTERN_KINDS)[number];

/**
 * An email address inside text: a local part, `@`, a dotted host ending in 2+ letters.
 *
 * The host tail is what separates this from a messenger handle — `@ivan` is a handle, `@ivan.co` is an
 * address. Both are reported, under different kinds, because they are different disclosures: one is a
 * way to reach the customer off-platform, the other is the customer's identity elsewhere.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/** A messenger handle: `@name`, at least two characters, not part of an email (checked by order below). */
const HANDLE = /(?:^|[^A-Za-z0-9._%+-])@[A-Za-z0-9_][A-Za-z0-9_.]{1,}/;

/**
 * A messenger link. Kept in the `handle` kind rather than given a fourth: what it discloses is the same
 * thing — a way to reach this person outside the product — and a vocabulary grows by decision, not by
 * enumerating spellings.
 */
const MESSENGER_LINK = /\b(?:t\.me|wa\.me|telegram\.me|m\.me)\/[A-Za-z0-9_.+]+/i;

/** An international dialling prefix followed by digits — the way a phone number is usually written. */
const DIALLING_PREFIX = /\+\s?\d[\d\s().-]{5,}/;

/**
 * A run of 7+ digits once the separators people write numbers with are removed.
 *
 * ⚠️ Seven, and grouped runs only — the `\d[\d\s().-]{5,}\d` shape rather than a bare `\d{7}` — so that
 * `12 34 56 78` is caught while a stray year or a three-digit amount is not. Our own numeric ids do trip
 * this, and that is accepted (see the header): the author waves the warning through in one click, and
 * the alternative is missing the numbers this exists for.
 */
const DIGIT_RUN = /\d[\d\s().-]{5,}\d/;

const digitsOnly = (value: string): string => value.replace(/[\s().+-]/g, '');

function hasPhoneShape(body: string): boolean {
  if (DIALLING_PREFIX.test(body)) return true;
  const run = DIGIT_RUN.exec(body);
  return run !== null && digitsOnly(run[0]).length >= 7;
}

/**
 * Which kinds of contact-shaped text this body contains. Sorted and deduplicated, so the answer is
 * stable enough to store and to compare in a test.
 *
 * An empty array means "nothing recognised" — never "not checked". The caller distinguishes those two
 * by whether it called this at all.
 */
export function contactShapedKinds(body: string): ContactPatternKind[] {
  if (!body) return [];
  const found = new Set<ContactPatternKind>();

  if (EMAIL.test(body)) found.add('email');
  // ⚠️ An email also matches the handle shape at its local part, so the handle test runs on the body
  // with addresses removed. Otherwise every note containing an address would report two kinds and the
  // audit entry would overstate what happened — a trail that overstates is worse than one that does
  // not, because its false entries are indistinguishable from its true ones (the feature-026 lesson).
  const withoutEmails = body.replace(new RegExp(EMAIL.source, 'g'), ' ');
  if (HANDLE.test(withoutEmails) || MESSENGER_LINK.test(body)) found.add('handle');
  if (hasPhoneShape(body)) found.add('phone');

  return CONTACT_PATTERN_KINDS.filter((kind) => found.has(kind));
}

/**
 * The kinds as the audit detail carries them — one comma-joined token from the closed vocabulary.
 *
 * ⚠️ It passes the audit value guard **by construction**, and that is the reason for the shape: the
 * guard refuses anything containing an `@` or a 7-digit run, so a kind LIST is expressible where a
 * matched value is not. `valueKind` (W9's key) could not be reused because three kinds can fire at
 * once and that key is singular by contract.
 */
export function patternKindsDetail(kinds: readonly ContactPatternKind[]): string {
  return kinds.join(',');
}
