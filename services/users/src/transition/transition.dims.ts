import type { Metadata } from '@grpc/grpc-js';

/**
 * The dimensions SNAPSHOT for an OPERATOR transition (feature 025, roadmap 5.9 — U7).
 *
 * ── Why a snapshot and not references ───────────────────────────────────────────────────────────
 * Reports must reflect the values **as they were**. If a transition stored a reference and the
 * report joined at read time, editing a label today would silently rewrite every past figure. So the
 * values are copied in once and never touched again — the same rule
 * `services/chats/src/transition/transition.dims.ts` states for conversations.
 *
 * ── ⚠️ ABSENT, not null ─────────────────────────────────────────────────────────────────────────
 * An operator transition has no brand, no assignee and no conversation. Those members are simply not
 * written. A `null` would claim the dimension existed and was empty, which is a different and false
 * statement — and a later feature must be able to start writing one **going forward** without anyone
 * backfilling or reinterpreting old rows.
 *
 * ── submitterRole ───────────────────────────────────────────────────────────────────────────────
 * Read from `x-actor-effective-role` — the role the caller is *acting as*. ⚠️ NOT `x-actor-role`,
 * which carries `claims.roles[0]`: under an owner view-as preview those differ, and the dimension a
 * team reports by is the effective one. Feature 018 added both headers precisely because reusing one
 * for two meanings is the silent kind of change.
 *
 * For a SWEEP-driven transition there is no caller and therefore no role — absent, correctly: the
 * system did it, and `actor_kind: 'system'` with the job naming itself is where that is recorded.
 *
 * Pure: builds a plain object, performs no I/O, decides nothing about whether to record.
 */
export interface TransitionDims {
  /** Present only on `operator.channel_availability_changed` — which channel the switch was about. */
  channel?: string;
  submitterRole?: string;
}

const first = (md: Metadata | undefined, key: string): string | undefined => {
  const v = md?.get?.(key)?.[0];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

/**
 * Build the snapshot. Every member is optional and an empty value is omitted rather than stored as
 * `""` — an empty string is a value, and this record must not claim one where there was none.
 */
export function buildOperatorDims(
  metadata?: Metadata,
  extra?: { channel?: string | null },
): TransitionDims {
  const dims: TransitionDims = {};
  const role = first(metadata, 'x-actor-effective-role');
  if (role) dims.submitterRole = role;
  if (extra?.channel) dims.channel = extra.channel;
  return dims;
}
