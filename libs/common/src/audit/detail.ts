import { classOf, isAuditAction, type AuditAction, type AuditClass } from './catalogue';

/**
 * `detail_json` validation (feature 015). Two constraints, because one is not enough:
 *
 *   1. **Keys** — a per-class allow-list. A key outside its class's list is refused.
 *   2. **Values** — must be an identifier or an enum-like token. A PII-shaped value is refused whatever
 *      key it arrives under.
 *
 * Both are needed. The key list stops `email` being added as a field; the value check stops a player's
 * email being smuggled into `name`, which IS a legitimate key on a deletion.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────────────────────────────
 * "Don't put PII in the audit detail" is a code-review rule, and code-review rules hold until the third
 * feature writes into the field under a deadline. An allow-list makes the safe thing the only expressible
 * thing — the same choice as feature 013's closed action vocabulary and feature 014's closed trigger set.
 *
 * It matters more here than anywhere else in the product: these rows *describe* PII access. A leak here
 * would file the protected value right next to the record of who wanted it.
 *
 * Pure module: no Prisma, no I/O, no clock.
 */

/** Thrown for a detail that is not expressible. Callers map it to INVALID_ARGUMENT. */
export class AuditDetailError extends Error {}

/** The keys each action class may carry. Anything else is refused. */
export const DETAIL_KEYS: Readonly<Record<AuditClass, readonly string[]>> = {
  // ⚠️ Feature 024 (groups) added seven `privilege` actions and NEEDED NO KEY HERE, which is worth
  // stating: a group action records `scope: 'group'`, `permissionKey` + `grant` for a binding change,
  // and `affectedCount` for how many members it moved. The group is identified by `target_ref`.
  //
  // In particular there is deliberately no `name` key for a rename. `name` is legal for `deletion`
  // because a deleted rule leaves nothing else to identify it by; a group still exists after being
  // renamed, so its name is readable from the row and copying it here would be the trail storing
  // state instead of referencing it (015: "target_ref identifies, never copies"). The cost is real
  // and accepted — after a group is deleted the trail names it only by id.
  // ⭐ W31 / 038: `keyFingerprint` is the ONE key this class gained. The three `api_key.*` actions
  // are filed under `privilege` (issuing a credential that mints staff accounts IS a grant of
  // authority), and FR-005 requires every one of them to carry a fingerprint — the short,
  // non-reversible label. Without this entry the requirement is inexpressible and the writer refuses
  // its own entry, which is how it was found. ⚠️ The VALUE can never appear: none is stored, and
  // `staffing` (the machine path) carries its own separate list below.
  privilege: ['scope', 'permissionKey', 'roleKey', 'grant', 'affectedCount', 'keyFingerprint'],
  // `name` is the rule's own operator-authored name — not customer data.
  deletion: ['name', 'revision'],
  // W27 / 036: the shelf transition — both STATES (`'' | suspended | deleted`), never a subject,
  // never a status key, never a customer value. Two closed words per entry, nothing else fits here.
  lifecycle: ['fromState', 'toState'],
  // ⭐ W31 / 038: `keyFingerprint` = the key's short non-reversible label (never the value — none is
  // stored); `reasonClass` = one of the closed refusal words (`signature | stale | unknown_key |
  // revoked_key | ip | rate | forbidden_role | malformed`); `employeeIdHash` = the SALTED sha256 of
  // the HR id, the W9 `valueHash` precedent — an investigator confirms «was this person provisioned»
  // by hashing the id, and nobody reads an employee number out of the trail; `movedCount` /
  // `noDeskCount` = what the handover did. No email, no name, no raw id, no body.
  staffing: ['keyFingerprint', 'reasonClass', 'employeeIdHash', 'movedCount', 'noDeskCount'],
  // `tier` = the most sensitive tier a read surfaced (never a field value).
  // `filters` = which fields a reader filtered on (names only, never their values).
  // W9 (ADR 0044 §4) — the lookup trio: `valueHash` = the SALTED sha256 of the searched contact
  // (64 hex chars — contains no `@` and no dialling shape, so the PII value guard passes it while
  // still refusing a raw address); `valueKind` = `email | phone` in clear; `matched` =
  // `found | none | ambiguous | rate_capped`. An investigator confirms "was this number looked up"
  // by hashing it; nobody reads the number out of the log.
  access: ['tier', 'filters', 'valueHash', 'valueKind', 'matched'],
  export: ['format', 'rowCount', 'scope'],
  // `reasonClass` (feature 031) = WHY routing found nobody, as a class: 'desk_not_routable',
  // 'nobody_available', 'all_at_capacity'. A class and never a sentence, so no relay's wording and no
  // customer detail can arrive through it.
  // `fromBrandRef` / `toBrandRef` (feature 032) = brand IDS, never a brand's name. The name lives in the
  // brands service, and copying it here would make the trail store state instead of referencing it — the
  // same rule that keeps a group's name out of `privilege` after a rename.
  // `channelKind` (feature 033) = `api | email | messenger` — the closed vocabulary from
  // `libs/common/src/channels/kinds.ts`, never a channel's key and never its address.
  // `identifierClass` (feature 033) = WHICH KIND of identifier decided who wrote: `email` | `phone` |
  // `player_id`. ⚠️ The class is recordable and the value never is (ADR 0044 §4) — an audited email
  // address would put customer contact data in the one table nothing may delete from.
  // `playerRef` / `brandRef` (W9, spec 035) = the attached/detached PAIR as ids — the pair, because
  // a bare player id names two customers (the 07-29 Person repair); ids, never names or contacts.
  assignment: [
    'selfAssigned',
    'managerRef',
    'reasonClass',
    'fromBrandRef',
    'toBrandRef',
    'channelKind',
    'identifierClass',
    'playerRef',
    'brandRef',
  ],
  retention: ['deletedCount', 'olderThan'],
};

/**
 * A value long enough to be prose rather than an identifier or an operator-authored name.
 *
 * 120 is generous for every real value: a permission key is ~25 characters, a rule name a few words. It is
 * deliberately NOT an attempt to tell a long rule name from a short message body — that distinction is not
 * decidable from the string, and pretending otherwise would be a false promise. What makes it safe anyway is
 * upstream: the only key that accepts free text (`name`) is populated by the product from
 * `Automation.name` — operator-authored configuration — and never from a customer-supplied field.
 */
const MAX_VALUE_LENGTH = 120;

/**
 * Shapes that mean "this is probably personal data".
 *
 * These match the value as a WHOLE rather than searching inside it, and that is a correction rather than a
 * style choice: the first version looked for a 16-digit run anywhere in the string, which rejected our own
 * identifiers — `seed-user-0000-0000-000000000001` is a legitimate `managerRef` and is also, to a naive
 * card detector, a card number. A PII check that refuses valid writes is worse than none, because it gets
 * relaxed rather than fixed.
 *
 * So: an at-sign anywhere is an email (nothing else in our vocabulary contains one), and a phone/card is
 * recognised only when the value contains no letters at all. An identifier always does.
 */
const containsAtSign = (v: string): boolean => /[@＠]/.test(v);

const digitsOnly = (v: string): string => v.replace(/[\s().+-]/g, '');

/** True when the whole value is digits and separators — i.e. it is a number, not an identifier. */
const isBareNumberLike = (v: string): boolean => /^[+\s().\d-]+$/.test(v);

/**
 * An international dialling prefix immediately followed by digits, ANYWHERE in the value. Our identifiers
 * never contain `+`, so this is safe to look for inside text — which the first version was not: it only
 * examined values that were entirely numeric, so `"phone: +34 600 123 456"` walked straight through.
 */
const hasDiallingPrefix = (v: string): boolean => /\+\s?\d[\d\s().-]{5,}/.test(v);

/**
 * Space-separated digit groups totalling 13–19 digits — a card number written the way people write them.
 * Keyed on SPACES deliberately: our identifiers group digits with hyphens and never with spaces, so this
 * catches `4111 1111 1111 1111` inside a sentence without touching `seed-user-0000-0000-000000000001`.
 */
const hasSpacedCardRun = (v: string): boolean => {
  const groups = v.match(/\b\d[\d\s]{10,}\d\b/g) ?? [];
  return groups.some((g) => {
    const digits = g.replace(/\s/g, '');
    return /\s/.test(g) && digits.length >= 13 && digits.length <= 19;
  });
};

function looksLikePersonalData(value: string): boolean {
  if (containsAtSign(value)) return true; // an email address
  if (hasDiallingPrefix(value)) return true; // a phone number, even inside text
  if (hasSpacedCardRun(value)) return true; // a card number, even inside text
  if (!isBareNumberLike(value)) return false; // otherwise: contains letters ⇒ an identifier, not a number
  // A bare number has no business in an audit detail as a STRING — our numeric details (`revision`,
  // `affectedCount`) are numbers.
  return digitsOnly(value).length >= 7;
}

export type DetailValue = string | number | boolean | string[];
export type AuditDetail = Record<string, DetailValue>;

function assertValue(key: string, value: unknown): DetailValue {
  if (typeof value === 'boolean' || typeof value === 'number') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new AuditDetailError(`detail ${key}: not a finite number`);
    }
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_VALUE_LENGTH) {
      // A long string in an audit detail is prose — a message body, a note, a reason someone typed.
      throw new AuditDetailError(`detail ${key}: value too long for an audit detail`);
    }
    if (looksLikePersonalData(value)) {
      throw new AuditDetailError(`detail ${key}: value looks like personal data`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    // A flat list of tokens only (e.g. which filters were used). No nesting.
    return value.map((v, i) => {
      if (typeof v !== 'string') {
        throw new AuditDetailError(`detail ${key}[${i}]: only strings are allowed in a list`);
      }
      return assertValue(`${key}[${i}]`, v) as string;
    });
  }
  // Objects, null, undefined-in-an-array, functions: a detail is flat by contract.
  throw new AuditDetailError(`detail ${key}: only strings, numbers, booleans and string lists`);
}

/**
 * Validate a detail for an action. Returns the normalised detail, or `undefined` when there is nothing to
 * store (so a caller never writes an empty `{}` that a reader has to interpret).
 *
 * @throws AuditDetailError on an unknown action, an unknown key, or a value that is not expressible.
 */
export function parseDetail(action: AuditAction, detail?: unknown): AuditDetail | undefined {
  if (!isAuditAction(action)) {
    // Refuse before looking at the detail: an unknown action has no allow-list to check against, and
    // guessing one would be exactly the free-text problem the catalogue exists to prevent.
    throw new AuditDetailError('unknown audit action');
  }
  if (detail === undefined || detail === null) return undefined;
  if (typeof detail !== 'object' || Array.isArray(detail)) {
    throw new AuditDetailError('detail must be an object');
  }

  const allowed = DETAIL_KEYS[classOf(action)];
  const out: AuditDetail = {};
  for (const [key, value] of Object.entries(detail as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (!allowed.includes(key)) {
      // Names the key and the allow-list, never the value — an error message must not become the leak.
      throw new AuditDetailError(
        `detail key '${key}' is not allowed for ${classOf(action)}: expected one of ${allowed.join(' | ')}`,
      );
    }
    out[key] = assertValue(key, value);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
