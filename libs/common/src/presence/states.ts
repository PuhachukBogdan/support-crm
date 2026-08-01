/**
 * The presence vocabulary and the one question routing asks (feature 025, roadmap 5.9 — ADR 0042 §7).
 *
 * ── ⚠️ THE WORD IS "STATE", NEVER "STATUS" ──────────────────────────────────────────────────────
 * "Status" is taken three times over in this product: a conversation's status (ADR 0040), an
 * escalation's status, and `TransitionStatus` in the transition catalogue. A fourth meaning of the
 * same word is how a reader ends up certain they already know what they are looking at.
 * `tests/naming/presence-is-not-active-nor-status.spec.ts` pins this.
 *
 * ── ⚠️ PRESENCE IS NOT `Operator.active` ────────────────────────────────────────────────────────
 * `active` means *the staff account is not deactivated* (roadmap 3.16). Presence means *this person
 * is at their desk right now*. `OperatorRepository.resolveByAuthUsers` already filters on `active`
 * and now also reads presence — the two meet in that exact query, and conflating them would make a
 * person at lunch indistinguishable from a person who left the company.
 *
 * ── Why availability is a FUNCTION and not a stored boolean ─────────────────────────────────────
 * There are TWO kinds of ask, and `transfers_only` answers them differently. A single
 * `isAvailable` column could not be correct for both, and it would be the copy that goes stale.
 *
 * Pure data + pure functions. No I/O.
 */

/** Ordered from most to least available. The order is load-bearing — see `isLowerAvailability`. */
export const PRESENCE_STATES = ['online', 'transfers_only', 'away', 'offline'] as const;
export type PresenceState = (typeof PRESENCE_STATES)[number];

export const isPresenceState = (v: unknown): v is PresenceState =>
  typeof v === 'string' && (PRESENCE_STATES as readonly string[]).includes(v);

/**
 * WHY a state was set.
 *
 * Not decoration: it is the difference between *"the system decided you were away"* and *"you told
 * us you were away"* — two facts a future WFM report must never merge — and it is what makes the
 * monotonicity rule decidable at all (see `mayHeartbeatRaise`).
 */
export const PRESENCE_CAUSES = ['manual', 'auto_inactivity', 'admin'] as const;
export type PresenceCause = (typeof PRESENCE_CAUSES)[number];

export const isPresenceCause = (v: unknown): v is PresenceCause =>
  typeof v === 'string' && (PRESENCE_CAUSES as readonly string[]).includes(v);

/**
 * The two askers. Separate values rather than one boolean, because `transfers_only` is precisely the
 * case where the answers differ — and that difference is the entire reason it is a STATE and not one
 * of the administrator-editable labels.
 */
export const AVAILABILITY_ASKS = ['new_push', 'human_transfer'] as const;
export type AvailabilityAsk = (typeof AVAILABILITY_ASKS)[number];

/**
 * The FR-010 matrix, written out in full rather than derived from a rule.
 *
 * Deriving it (e.g. "available unless the state index exceeds N") would be shorter and would make
 * the one interesting cell — `transfers_only` — an emergent property of an ordering rather than a
 * decision somebody made. Every cell here is a decision, so every cell is written down.
 *
 * | state           | new_push | human_transfer |
 * |-----------------|----------|----------------|
 * | online          | yes      | yes            |
 * | transfers_only  | NO       | YES            |
 * | away            | no       | no             |
 * | offline         | no       | no             |
 */
const MATRIX: Readonly<Record<PresenceState, Readonly<Record<AvailabilityAsk, boolean>>>> = {
  online: { new_push: true, human_transfer: true },
  transfers_only: { new_push: false, human_transfer: true },
  away: { new_push: false, human_transfer: false },
  offline: { new_push: false, human_transfer: false },
};

/** Does this state permit this kind of ask? The ONE place the matrix is consulted. */
export function stateAllows(state: PresenceState, ask: AvailabilityAsk): boolean {
  return MATRIX[state][ask];
}

/**
 * Availability, complete.
 *
 * THREE independent conditions, written as three so none can quietly absorb another:
 *   1. the staff account is not deactivated  — a different fact (3.16), deliberately separate;
 *   2. the state permits this kind of ask    — the matrix above;
 *   3. the channel is not switched off       — absence of a block means available (FR-019).
 *
 * `channel` is `null` for a conversation whose channel was never recorded. Feature 022 went to real
 * trouble to keep that case distinct from every possible channel NAME, and the distinction is honoured
 * here: an unrecorded channel is answered at state level alone, never matched against a block.
 */
export function isAvailableFor(input: {
  ask: AvailabilityAsk;
  operatorActive: boolean;
  state: PresenceState;
  channel: string | null;
  blockedChannels: readonly string[];
}): boolean {
  if (!input.operatorActive) return false;
  if (!stateAllows(input.state, input.ask)) return false;
  if (input.channel !== null && input.blockedChannels.includes(input.channel)) return false;
  return true;
}

/**
 * ⭐ Decode a presence state off the WIRE, in either spelling.
 *
 * ── Why both spellings, and why this is shared ──────────────────────────────────────────────────
 * `grpcClientOptions` loads protos with `enums: String`, so a response carries
 * `"PRESENCE_STATE_ONLINE"` — a NAME — while a request may legitimately carry the numeric tag. The
 * first live run of feature 025 found the gap the expensive way: the gateway decoded by number only,
 * so every read fell through to `offline` and reported somebody at their desk as absent. Writes kept
 * working, because a number sent outward needs no decoding — which is exactly why unit tests, whose
 * fakes echo numbers, all passed.
 *
 * ⚠️ Unknown input returns `null`, never a default. A state that silently became `online` would WIDEN
 * availability, and the widening direction is the one that pushes live customers at absent agents.
 * The caller decides what to do with `null`; this function never guesses.
 */
const WIRE_NAME_TO_STATE: Readonly<Record<string, PresenceState>> = {
  PRESENCE_STATE_ONLINE: 'online',
  PRESENCE_STATE_TRANSFERS_ONLY: 'transfers_only',
  PRESENCE_STATE_AWAY: 'away',
  PRESENCE_STATE_OFFLINE: 'offline',
};

const WIRE_TAG_TO_STATE: Readonly<Record<number, PresenceState>> = {
  1: 'online',
  2: 'transfers_only',
  3: 'away',
  4: 'offline',
};

export function decodeWireState(raw: unknown): PresenceState | null {
  if (typeof raw === 'number') return WIRE_TAG_TO_STATE[raw] ?? null;
  if (typeof raw === 'string') {
    if (isPresenceState(raw)) return raw;
    return WIRE_NAME_TO_STATE[raw] ?? null;
  }
  return null;
}

/** The same problem one field over: the cause comes back as a NAME too. */
const WIRE_NAME_TO_CAUSE: Readonly<Record<string, PresenceCause>> = {
  PRESENCE_CAUSE_MANUAL: 'manual',
  PRESENCE_CAUSE_AUTO_INACTIVITY: 'auto_inactivity',
  PRESENCE_CAUSE_ADMIN: 'admin',
};

export function decodeWireCause(raw: unknown): PresenceCause | null {
  if (typeof raw === 'number') return (['manual', 'auto_inactivity', 'admin'][raw - 1] as PresenceCause) ?? null;
  if (typeof raw === 'string') {
    if (isPresenceCause(raw)) return raw;
    return WIRE_NAME_TO_CAUSE[raw] ?? null;
  }
  return null;
}

/** Position in the availability ordering — lower index is MORE available. */
const rank = (s: PresenceState): number => PRESENCE_STATES.indexOf(s);

/**
 * Is `to` strictly less available than `from`? The sweep may only ever move in this direction
 * (FR-016), and asserting it as a property is cheaper than trusting every future caller.
 */
export const isLowerAvailability = (from: PresenceState, to: PresenceState): boolean =>
  rank(to) > rank(from);

/**
 * ⭐ May a heartbeat raise this person back to `online`?
 *
 * Only from a state the SWEEP set, or from the never-set default. The two refusals matter more than
 * the permission:
 *
 *   • `manual` — a person set themselves to "Lunch". Their browser is still open and still beating.
 *     The system does not get to decide that somebody's lunch is over.
 *   • `admin`  — a supervisor corrected a wrong presence. If a heartbeat undid that, the correction
 *     would be reverted by the very stale session that made it necessary, and the feature would be
 *     worse than useless: it would look like it worked.
 *
 * This is the function that makes `last_cause` a stored column rather than a derivable one.
 */
export const mayHeartbeatRaise = (cause: PresenceCause | null): boolean =>
  cause === null || cause === 'auto_inactivity';
