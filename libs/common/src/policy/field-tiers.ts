/**
 * Contact-field visibility tiers (feature 011, US4 / T043 — anti-pitching, ADR 0032 §3/§5,
 * SEC-AP1..AP3). Stateless policy data + helpers consumed by the owning service that serves
 * contacts (Users `Player` read path). Masking is done by ALLOW-LIST DTO construction (the
 * masking function builds the response from only the fields a role may see) so masked fields are
 * **structurally absent**, never nulled (FR-014).
 *
 * U1 / R-4 / 0032 SCOPE: this maps only the fields that exist on the current `Player` model today.
 * `am_only` = am_notes / preferences / portfolio; `operational` = vip / segment / custom_attributes.
 * The `open` tier's intended contact fields (display name, birthday-no-year, registration date)
 * and the `masked_pii` fields (surname / phone / email / address) are **GR8-sourced** and live in
 * the opaque `gr8_snapshot` — they are NOT typed `Player` columns and MUST NOT be added as such;
 * they slot into the same allow-list when a contact path exposes them. `gr8_snapshot` itself is
 * treated as `masked_pii` (it carries GR8 PII).
 */

/** Visibility tier a contact field belongs to. */
export type FieldTier = 'open' | 'operational' | 'am_only' | 'masked_pii';

/**
 * Field → tier classification for the current `Player` model. Any field NOT listed here defaults
 * to `masked_pii` (fail-closed): an unclassified new field is hidden from everyone but the
 * PII-cleared tiers until it is deliberately classified.
 */
export const FIELD_TIERS: Readonly<Record<string, FieldTier>> = {
  // open — safe for every role that can open the card at all.
  player_id: 'open',
  created_at: 'open', // registration-date proxy in our system
  updated_at: 'open',
  brands: 'open',
  gr8_stale: 'open',
  gr8_fetched_at: 'open',
  // operational — VIP Support and above (routing / segment signal).
  vip: 'operational',
  segment: 'operational',
  custom_attributes: 'operational',
  // am_only — AM & Shift AM (our own portfolio, replaces the Excel).
  am_notes: 'am_only',
  preferences: 'am_only',
  portfolio: 'am_only',
  // masked_pii — the opaque GR8 snapshot carries contact PII (surname/phone/email/address).
  gr8_snapshot: 'masked_pii',
} as const;

/**
 * Which tiers each role may see. Linear roles (support agent) see `open` ONLY (FR-014). VIP Support
 * adds `operational`; AM / Shift AM add `am_only`; admin / super-admin additionally see `masked_pii`.
 * A role not listed here is treated as linear (open only) — fail-closed.
 */
export const ROLE_VISIBLE_TIERS: Readonly<Record<string, readonly FieldTier[]>> = {
  support_agent: ['open'],
  teamlead: ['open', 'operational'],
  vip_support: ['open', 'operational'],
  am: ['open', 'operational', 'am_only'],
  shift_am: ['open', 'operational', 'am_only'],
  admin: ['open', 'operational', 'am_only', 'masked_pii'],
  super_admin: ['open', 'operational', 'am_only', 'masked_pii'],
} as const;

/** The tiers visible to a role (linear/open-only fallback for an unknown role). */
export function visibleTiersFor(roleKey: string): readonly FieldTier[] {
  return ROLE_VISIBLE_TIERS[roleKey] ?? ['open'];
}

/** The set of `Player` field names a role may see (allow-list source for masking). */
export function allowedFields(roleKey: string): Set<string> {
  const tiers = new Set(visibleTiersFor(roleKey));
  return new Set(Object.entries(FIELD_TIERS).filter(([, t]) => tiers.has(t)).map(([f]) => f));
}

/**
 * The maskable tiers a read actually surfaces for a role (anything beyond `open`) — drives the
 * contact-view audit (SEC-AP3): a read that exposes operational/am_only/masked_pii is recorded.
 */
export function surfacedMaskableTiers(roleKey: string): FieldTier[] {
  return visibleTiersFor(roleKey).filter((t) => t !== 'open');
}

/**
 * Mass export gate (FR-017 / SEC-AP2): a masked (linear, open-only) role may NOT bulk-export
 * contacts. Returns false for any role whose visible tiers are open-only.
 */
export function canMassExportContacts(roleKey: string): boolean {
  return visibleTiersFor(roleKey).some((t) => t !== 'open');
}
