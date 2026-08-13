import type { Metadata } from '@grpc/grpc-js';

/**
 * The dimensions SNAPSHOT (feature 023, roadmap 4.8a — FR-003 / SC-003).
 *
 * ── Why a snapshot and not references ────────────────────────────────────────────────────────────
 * Reports must reflect the values **as they were**. If a transition stored `brand_id` and the report
 * joined to `Brand` at read time, renaming a brand would silently rewrite every past figure — the
 * operator's history would change because someone edited a label today. So the values are copied in,
 * once, and never touched again.
 *
 * ── ABSENT, not null ─────────────────────────────────────────────────────────────────────────────
 * `group` (roadmap 5.3) and `form` (roadmap 4.15) do not exist in this product yet. They are simply
 * not written. A `null` would claim the dimension existed and was empty, which is a different and
 * false statement — and a later feature must be able to start writing them **going forward** without
 * anyone backfilling or reinterpreting old rows.
 *
 * ── submitterRole ────────────────────────────────────────────────────────────────────────────────
 * Read from `x-actor-effective-role` — the role the caller is *acting as*. ⚠️ NOT `x-actor-role`,
 * which carries `claims.roles[0]`: under an owner view-as preview those differ, and the dimension the
 * team reports by is the effective one. Feature 018 added both headers precisely because reusing one
 * for two meanings is the silent kind of change.
 *
 * Pure: builds a plain object, performs no I/O, decides nothing about whether to record.
 */
export interface TransitionDims {
  brand?: string;
  channel?: string;
  assignee?: string;
  submitterRole?: string;
  /** ⭐ Feature 037 (roadmap 4.15 — W30): the form the conversation was filed under AT THE MOMENT
   *  of the transition. The header's reservation, now written — going forward only, no backfill. */
  form?: string;
}

/** The conversation columns a snapshot is taken from. Deliberately a structural type, not the row. */
export interface DimsSource {
  brand_id?: string | null;
  channel?: string | null;
  assignee_operator_id?: string | null;
  form_key?: string | null;
}

const first = (md: Metadata | undefined, key: string): string | undefined => {
  const v = md?.get(key)?.[0];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

/**
 * Build the snapshot. Every member is optional and an empty value is omitted rather than stored as
 * `""` — an empty string is a value, and this record must not claim one where there was none.
 */
export function buildTransitionDims(
  source: DimsSource,
  metadata?: Metadata,
): TransitionDims {
  const dims: TransitionDims = {};

  if (source.brand_id) dims.brand = source.brand_id;
  if (source.channel) dims.channel = source.channel;
  if (source.assignee_operator_id) dims.assignee = source.assignee_operator_id;

  const role = first(metadata, 'x-actor-effective-role');
  if (role) dims.submitterRole = role;

  // ⭐ W30 delivered the header's `form` reservation; `group` (roadmap 5.3) stays intentionally unwritten.
  if (source.form_key) dims.form = source.form_key;

  return dims;
}
