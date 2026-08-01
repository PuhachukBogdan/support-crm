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
 * Field → tier classification for the current `Player` model.
 *
 * ⚠️ **An unlisted field is visible to NOBODY — not even `super_admin`.** `allowedFields` builds the
 * allow-list by filtering *this map*, so a field absent from it belongs to no tier and therefore
 * lands in no role's permitted set. Fail-closed in the strongest available sense.
 *
 * This comment previously said an unclassified field "defaults to `masked_pii`", i.e. that it stayed
 * visible to the PII-cleared tiers. That was never what the code did (corrected during feature 018,
 * T047a). The behaviour is the safer of the two readings and is kept; only the description was wrong
 * — and a policy whose comment overstates who can see a field is the kind of error that gets
 * "simplified" into a real leak by the next reader who trusts the prose over the code.
 *
 * Consequence worth knowing when adding a column: classifying it is **required** for it to be
 * served at all. A forgotten classification shows up as an empty field for every role, never as an
 * accidental disclosure — see `tier-agreement.spec.ts`, which verifies this by adding one.
 */
export const FIELD_TIERS: Readonly<Record<string, FieldTier>> = {
  // open — safe for every role that can open the card at all.
  player_id: 'open',
  created_at: 'open', // registration-date proxy in our system
  updated_at: 'open',
  // Feature 020: the brand is a COLUMN and part of the player's identity. Open, as `brands` was —
  // a linear role could always see which brand a customer came from; what changed is that the value
  // now identifies the record rather than listing a union. (`brands` stays for the deprecated wire
  // field until nothing reads it.)
  brand_id: 'open',
  // Feature 022 (roadmap 4.13): WHICH HUMAN this brand-scoped record belongs to. Open for the same
  // reason `player_id` and `brand_id` are — it is an internal grouping identifier, i.e. identity,
  // not contact data, and it carries no value a pitch could use.
  //
  // ⚠️ Classifying it is MANDATORY, not cosmetic: `allowedFields` filters THIS map, so an unclassified
  // field is served to nobody at all (see the note above). And because `open` never appears in
  // `surfacedMaskableTiers`, adding it changes NO audit behaviour — a `contact.reveal` entry is still
  // written exactly when a maskable tier is surfaced, which is what let feature 022 claim it adds no
  // audit action and prove it (`field-tiers.spec.ts`).
  person_id: 'open',
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

/**
 * The tiers visible to a role, **as a property of the role alone**.
 *
 * ⚠️ Since feature 026 this is the answer to *"what could this role EVER see?"*, which is NOT the
 * same question as *"what may this role see about THIS record?"* — see `visibleTiersForSubject`
 * below. Two questions, two names, deliberately: the bulk-export gate and the bulk-read audit
 * legitimately ask the first, and giving them one function that silently answered the second is how
 * a per-record rule leaks into a place that has no record.
 */
export function visibleTiersFor(roleKey: string): readonly FieldTier[] {
  return ROLE_VISIBLE_TIERS[roleKey] ?? ['open'];
}

/**
 * ⭐ Feature 026 (roadmap 5.7) — the tiers visible to a role **about one particular player**.
 *
 * ── What changed, and why it is not additive ────────────────────────────────────────────────────
 * Before this, the `am_only` tier (`am_notes`, `preferences`, `portfolio`) was gated BY ROLE ALONE:
 * anybody with the AM role read the portfolio of EVERY player in the account. Roadmap 5.7 requires
 * that an AM cannot read a player they are not attached to, so this narrows a **shipped** capability.
 *
 * ── The rule, DERIVED from the map above rather than from a list of role names ──────────────────
 *
 *     sees am_only  ⟺  role has am_only  AND  ( role has masked_pii  OR  attached )
 *
 * `masked_pii` **is** the administrative clearance — `admin` and `super_admin` are the only roles
 * that hold it. So administrators keep the tier by role (making an administrator attach themselves
 * to read a record would be theatre, and their reads are already audited), while `am`/`shift_am`
 * are narrowed.
 *
 * A hardcoded `['am','shift_am']` would drift the first time a role is added, and drift silently.
 * This derivation self-maintains, and in the safe direction both ways: a future role given
 * `masked_pii` is administrative by definition; a future role given `am_only` alone is narrowed
 * automatically.
 *
 * ⚠️ **Only `am_only` narrows.** `open` and `operational` stay role-gated — otherwise an AM could
 * not see enough of an unattached player to attach them, and self-assignment would be unreachable.
 * That clause is what makes the narrowing coherent rather than a deadlock.
 */
export function visibleTiersForSubject(
  roleKey: string,
  opts: { attachedToSubject: boolean },
): readonly FieldTier[] {
  const tiers = visibleTiersFor(roleKey);
  if (!tiers.includes('am_only')) return tiers;
  if (tiers.includes('masked_pii') || opts.attachedToSubject) return tiers;
  return tiers.filter((t) => t !== 'am_only');
}

/**
 * The set of `Player` field names a role may see about ONE player (allow-list source for masking).
 *
 * ⚠️ `opts` is REQUIRED, and that is the enforcement rather than a style choice: making the
 * parameter mandatory turns *"did every call site consider the attachment?"* into a question the
 * compiler answers. An optional flag would have produced zero errors and changed nothing.
 */
export function allowedFields(roleKey: string, opts: { attachedToSubject: boolean }): Set<string> {
  const tiers = new Set(visibleTiersForSubject(roleKey, opts));
  return new Set(Object.entries(FIELD_TIERS).filter(([, t]) => tiers.has(t)).map(([f]) => f));
}

/**
 * The maskable tiers a read of ONE record actually surfaces (anything beyond `open`) — drives the
 * contact-view audit (SEC-AP3).
 *
 * ⭐ **Feature 026 gave this the attachment too, and that is not tidiness.** Its call site used to
 * say the recorded tier *"follows the caller's CLEARANCE, not which fields held a value"* — exactly
 * right while clearance was a property of the role alone. It is now a property of the role **and
 * this record**: an entry claiming an unattached AM surfaced `am_only` would OVERSTATE a trail whose
 * entire purpose is detecting over-reach. And a trail that overstates is worse than one that
 * understates, because its false entries are indistinguishable from its true ones.
 *
 * ⚠️ The BULK read keeps the role-level answer (`visibleTiersFor`) on purpose — its entry names a
 * BRAND, not a record, so there is no single attachment to ask about, and the caller's clearance
 * genuinely can surface the tier for some of the rows.
 */
export function surfacedMaskableTiers(
  roleKey: string,
  opts: { attachedToSubject: boolean },
): FieldTier[] {
  return visibleTiersForSubject(roleKey, opts).filter((t) => t !== 'open');
}

/** The role-level equivalent, for a bulk read whose entry names a brand rather than a record. */
export function surfacedMaskableTiersForRole(roleKey: string): FieldTier[] {
  return visibleTiersFor(roleKey).filter((t) => t !== 'open');
}

/**
 * Mass export gate (FR-017 / SEC-AP2): a masked (linear, open-only) role may NOT bulk-export
 * contacts. Returns false for any role whose visible tiers are open-only.
 */
export function canMassExportContacts(roleKey: string): boolean {
  return visibleTiersFor(roleKey).some((t) => t !== 'open');
}
