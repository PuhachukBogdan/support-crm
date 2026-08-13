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
  //
  // ⚠️ **`users.ChannelParticipant.address` (feature 033) IS DELIBERATELY ABSENT FROM THIS MAP, and its
  // absence is not an oversight — it was tried and removed.**
  //
  // It is a clear-text contact value, so classifying it looked obviously right. `tier-agreement.spec.ts`
  // refused it, and the refusal is correct: this map governs the **`Player` read path**, and its keys must
  // be fields of that DTO. `ChannelParticipant.address` is on another model and is served through no
  // player projection at all — it leaves `users` only via `GetChannelEnvelope`, a system-actor rpc with no
  // gateway route, called by the outbound delivery path.
  //
  // Putting it here would have claimed a protection it does not have: the fail-closed guarantee above
  // ("an unclassified field is served to nobody") applies to fields served THROUGH this map, so an entry
  // for a field nothing here serves protects nothing while reading as though it does. Its actual
  // protection is threefold and stated where it lives (`users/prisma/schema.prisma`): it is in the service
  // that owns contact values, it is reachable by exactly one rpc that no route exposes, and it is never
  // logged. If a card field ever surfaces it to a person, THAT field belongs in this map.
} as const;

/**
 * Which tiers each role may see. Linear roles (support agent) see `open` ONLY (FR-014). VIP Support
 * adds `operational`; AM / Shift AM add `am_only`; admin / super-admin additionally see `masked_pii`.
 * A role not listed here is treated as linear (open only) — fail-closed.
 */
export const ROLE_VISIBLE_TIERS: Readonly<Record<string, readonly FieldTier[]>> = {
  // ⭐ W31 / feature 038: the starter role a provisioning invitation carries. `open` only — the same
  // clearance as a support agent and the narrowest this map can express.
  //
  // ⚠️ It is written down rather than left to the fail-closed fallback ON PURPOSE. The fallback gives
  // the identical answer today, so the entry changes no behaviour; what it changes is that the
  // clearance of a role a MACHINE can hand out became a decision somebody made, in the same table as
  // every other role, instead of a default nobody looked at. Q26 may widen the newcomer's
  // permissions; whoever does that will find this line and have to think about the data tier too.
  newcomer: ['open'],
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
/**
 * ⭐ Feature 030 (roadmap 4.14) — does this role's work get narrowed to **its own portfolio**?
 *
 *     narrows  ⟺  role sees `am_only`  ∧  ¬ role sees `masked_pii`
 *
 * The same derivation {@link visibleTiersForSubject} performs for player *fields*, asked about
 * *conversations* instead. It lives **here** rather than in `chats` for the reason the repo-wide
 * `single-policy-path` guard enforces: the tier vocabulary has one home and clearance is computed in one
 * place. A copy of this arithmetic in another service would be the second mechanism deciding access that
 * ADR 0039 §2 forbids — and two mechanisms that both decide access will diverge, invisibly, until
 * somebody sees something they should not.
 *
 * ⚠️ **An unknown role does NOT narrow**, and that is deliberate rather than lax. `x-actor-effective-role`
 * is set by the gateway only when a role resolves, so its absence is a reachable normal state; narrowing
 * on it would empty the queue for every such caller. It also agrees with {@link visibleTiersFor}, which
 * already answers an unknown role as *least privileged and not an AM* — such a caller receives no
 * `am_only` field either, which bounds the exposure. Answering differently here would be the divergence
 * this function exists to prevent.
 */
export function narrowsToOwnPortfolio(roleKey: string): boolean {
  if (!roleKey || !Object.prototype.hasOwnProperty.call(ROLE_VISIBLE_TIERS, roleKey)) return false;
  const tiers = visibleTiersFor(roleKey);
  return tiers.includes('am_only') && !tiers.includes('masked_pii');
}

/**
 * ⭐ Feature 031 (roadmap 4.20/4.21, ADR 0042) — may **automatic distribution** hand work to this role?
 *
 *     is a queue role  ⟺  the role is KNOWN  ∧  it does not see `am_only`
 *
 * Derived, and derived **positively**: the router asks *"who staffs a queue?"* rather than *"who is not an
 * account manager?"*. The difference matters, because a pool built by exclusion is one config change from
 * including somebody, while a pool built from queue roles cannot reach an AM at all.
 *
 * ⚠️ **It lives here, not in the router, and a shipped guard enforces that.**
 * `services/chats/tests/data-model/am-not-a-queue-agent-030.spec.ts` fails if any distribution, automation,
 * routing, capacity or SLA module **names** a role or a tier — and feature 030 was caught by it once for
 * importing a rule while still doing the tier arithmetic itself. Reusing a rule and recomputing it are
 * different things, and the second looks like the first.
 *
 * Two exclusions fall out of the one condition, and both are intended:
 *
 * - **`am` / `shift_am`** work a **portfolio**, not a queue (scope brief §4/§9.1). A person may still hand
 *   one of them a conversation deliberately; what is forbidden is the machine choosing them.
 * - **`admin` / `super_admin`** see every tier, `am_only` included, so they are excluded too — and that is
 *   right: an administrator is not a destination for customer conversations. A router that could pick them
 *   would put work where nobody is watching for it.
 *
 * ⚠️ **An unknown role is NOT a queue role.** Fail-closed is unambiguous in this direction: the cost of
 * refusing to route to somebody unrecognised is that a person waits, and it is visible. The cost of routing
 * to them is a customer conversation sitting with somebody the system cannot describe.
 */
export function isQueueRole(roleKey: string): boolean {
  if (!roleKey || !Object.prototype.hasOwnProperty.call(ROLE_VISIBLE_TIERS, roleKey)) return false;
  return !visibleTiersFor(roleKey).includes('am_only');
}

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
 * ⭐ W35 / feature 040 — may this caller read the account manager's own material about THIS player?
 *
 *     sees it  ⟺  `am_only` survives {@link visibleTiersForSubject} for this role and this record
 *
 * ── Why a predicate here and not a tier check at the call site ───────────────────────────────────
 * Player notes (W35) are not a `Player` column, so `allowedFields` cannot answer for them — the
 * allow-list shapes a ROW, and a note is a table. But their visibility must be **the same fact** as
 * `am_notes`' was, or the product would hold two answers to *"who may read what an AM wrote about this
 * customer"*, and two answers diverge the first time one is updated (the divergence-with-a-delay-fuse
 * `single-policy-path.spec.ts` exists to prevent).
 *
 * So the question is asked HERE, where the vocabulary lives, and derived from the same function the
 * field masking uses. The notes service calls this and never names a tier — which is also what keeps
 * the repo-wide guard's promise ("a distinctive tier name appears only in the policy") true of the new
 * code without an exemption.
 *
 * The three sibling predicates above ({@link narrowsToOwnPortfolio}, {@link isQueueRole}) are the same
 * pattern: a domain question answered by deriving from the tier map rather than by listing role names,
 * so a role added later is classified automatically and in the safe direction.
 */
export function seesAmOnlyTier(roleKey: string, opts: { attachedToSubject: boolean }): boolean {
  return visibleTiersForSubject(roleKey, opts).includes('am_only');
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
