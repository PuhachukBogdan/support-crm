/**
 * ⭐ W32 (спек №3 / feature 039, roadmap 12.10) — wire types for the denied-addresses screen.
 *
 * Shapes mirror `specs/039-handover-bans-posture/contracts/api.md` §A1 and are restated here because
 * `web/` deliberately imports nothing from the services' shared library (the `RealtimeEvent`
 * precedent in `data-access.ts`, followed by `features/api-keys/types.ts`).
 *
 * ⚠️ **An empty list of these denies NOBODY** (FR-027). The identical-looking list one screen over —
 * an API key's `ipAllowList` — means the opposite when empty: nobody may call. Nothing in the types
 * can carry that difference, so the SCREEN says it in words, in the empty state and in the header.
 */

export interface DeniedAddressWire {
  id: string;
  /** The NORMALISED form — what the boundary actually compares (FR-029), not what was typed. */
  address: string;
  /** `''` when none. A short human reason, never required. */
  note: string;
  createdAt: string;
  /** An opaque user id; the screen joins it to a name it already knows (the audit-log precedent). */
  createdBy: string;
}

/** POST body. Two fields, both the administrator's own words — nothing else may create an entry. */
export interface AddDeniedAddressBody {
  address: string;
  note: string;
}

/**
 * The POST's answer.
 *
 * ⚠️ **`created: false` is a SUCCESS** (FR/US4 scenario 6): the address was already listed, the
 * unique index absorbed the write, and the row that comes back is the existing one. An administrator
 * who bans the same address twice has expressed the same intent twice — the screen says so and does
 * not colour it as a failure.
 */
export interface AddDeniedAddressResult {
  address: DeniedAddressWire | null;
  created: boolean;
}

/** The DELETE's answer. `removed: false` = it was already gone, which is also not an error. */
export interface RemoveDeniedAddressResult {
  removed: boolean;
}

/** What one write produced, in the screen's own terms — see `use-denied-addresses.ts`. */
export type WriteOutcome = 'saved' | 'unchanged' | 'refused';
