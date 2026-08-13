/**
 * ⭐ W31 (спек №2 / feature 038, roadmap 3.17) — wire types for the API-keys screen.
 *
 * Shapes mirror the admin half of `specs/038-staff-provisioning-api/contracts/api.md` §B/§C and are
 * restated here because `web/` deliberately imports nothing from the services' shared library (the
 * `RealtimeEvent` precedent in `data-access.ts`).
 *
 * ⚠️ **`ApiKeyWire` has no `value` member, and that absence is the security property** (ADR 0043 §5,
 * FR-001): the listing message carries no secret anywhere in the product, so a leak here cannot be a
 * forgotten filter — there is nothing to filter. Exactly one shape ever carries a value,
 * `IssuedApiKeyWire`, and it is only ever a WRITE's answer: issuance and rotation. Nothing re-reads
 * it, which is why a lost key is rotated rather than recovered.
 */

export interface ApiKeyWire {
  id: string;
  /** The named consumer — one key, one caller (ADR 0043 §5: per-consumer keys, never a shared one). */
  consumer: string;
  /** The public, non-reversible short form shown in the list and written into every journal entry. */
  fingerprint: string;
  /** ⚠️ Empty means NOBODY, never anybody — the fail-closed default (FR-002, spec «Edge Cases»). */
  ipAllowList: string[];
  ratePerHour: number;
  /** `false` = revoked. The row survives revocation: the journal keeps its history (FR-003). */
  active: boolean;
  /** ISO-8601, or empty when the key has never been used. */
  lastUsedAt: string;
  createdAt: string;
  /** The key this one replaced, when it was minted by a rotation. Empty for a first issuance. */
  rotatedFromId: string;
}

/** POST body for an issuance. Three facts, all of them the administrator's to choose. */
export interface IssueApiKeyBody {
  consumer: string;
  ipAllowList: string[];
  ratePerHour: number;
}

/**
 * The one answer in the product that carries a secret — `<id>.<secret>`, once, at issuance or
 * rotation (contracts §C: «value present ONCE»). It is never stored on the client past the moment
 * the administrator dismisses the panel showing it.
 */
export interface IssuedApiKeyWire {
  key: ApiKeyWire;
  value: string;
}

/**
 * The addresses field is one text line, because that is how an administrator holds a short
 * allow-list in their head — the parse is deliberately forgiving (commas, spaces or newlines) and
 * drops empties, so a trailing comma never becomes an entry that matches nothing.
 */
export function parseAddressList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}
