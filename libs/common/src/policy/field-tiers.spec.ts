import {
  allowedFields,
  isQueueRole,
  narrowsToOwnPortfolio,
  canMassExportContacts,
  FIELD_TIERS,
  ROLE_VISIBLE_TIERS,
  surfacedMaskableTiers,
  surfacedMaskableTiersForRole,
  visibleTiersFor,
} from './field-tiers';

/**
 * Feature 011 US4 (T039). The field-tier registry classifies contact fields and resolves what each
 * role may see. Linear roles get `open` only; VIP Support adds operational; AM/Shift AM add am_only;
 * admin/super-admin add masked_pii. Drives allow-list masking (SC-006) + the audit + export gate.
 */
describe('field-tiers policy', () => {
  it('gives a linear role (support_agent) the open tier ONLY', () => {
    expect(visibleTiersFor('support_agent')).toEqual(['open']);
    const fields = allowedFields('support_agent', { attachedToSubject: false });
    expect(fields.has('player_id')).toBe(true);
    // masked / operational / am_only fields are NOT visible to a linear role.
    for (const hidden of ['vip', 'segment', 'am_notes', 'preferences', 'portfolio', 'gr8_snapshot']) {
      expect(fields.has(hidden)).toBe(false);
    }
  });

  it('gives VIP Support operational but NOT am_only or masked_pii', () => {
    const fields = allowedFields('vip_support', { attachedToSubject: false });
    expect(fields.has('segment')).toBe(true);
    expect(fields.has('vip')).toBe(true);
    expect(fields.has('am_notes')).toBe(false);
    expect(fields.has('gr8_snapshot')).toBe(false);
  });

  it('gives AM the am_only fields (portfolio replaces the Excel)', () => {
    const fields = allowedFields('am', { attachedToSubject: true });
    expect(fields.has('am_notes')).toBe(true);
    expect(fields.has('preferences')).toBe(true);
    expect(fields.has('portfolio')).toBe(true);
    // AM still does not get the raw GR8 PII snapshot (that stays PII-cleared roles only).
    expect(fields.has('gr8_snapshot')).toBe(false);
  });

  it('gives super_admin the masked_pii tier', () => {
    expect(allowedFields('super_admin', { attachedToSubject: false }).has('gr8_snapshot')).toBe(true);
  });

  it('treats an unknown role as linear (open-only, fail-closed)', () => {
    expect(visibleTiersFor('nope')).toEqual(['open']);
  });

  it('reports the maskable tiers a read surfaces (audit driver)', () => {
    expect(surfacedMaskableTiers('support_agent', { attachedToSubject: false })).toEqual([]); // open only → nothing to audit
    // ⭐ Feature 026: the tier an entry records now depends on the RECORD, not only the role. An
    // ATTACHED AM surfaces the portfolio…
    expect(surfacedMaskableTiers('am', { attachedToSubject: true })).toEqual(['operational', 'am_only']);
    // …and an UNATTACHED one does not, so the entry must not claim they did. A trail that overstates
    // is worse than one that understates: its false entries look exactly like its true ones.
    expect(surfacedMaskableTiers('am', { attachedToSubject: false })).toEqual(['operational']);
    // The BULK read keeps the role-level answer, because its entry names a brand rather than a
    // record — there is no single attachment to ask about, and the clearance genuinely can surface
    // the tier for some of the page.
    expect(surfacedMaskableTiersForRole('am')).toEqual(['operational', 'am_only']);
  });

  /**
   * Feature 022 (roadmap 4.13) — `person_id` is `open`, and the second assertion is the load-bearing one.
   *
   * The field says which HUMAN a brand-scoped record belongs to. It is identity, not contact data, so
   * every role that can open a card at all may see it — a linear agent has always been able to see
   * which brand a customer came from, and "these two records are the same person" is the same class of
   * fact with no value attached.
   *
   * What must NOT change is the audit behaviour. `contact.reveal` is written when a read surfaces a
   * MASKABLE tier, and `open` is not one — so this addition writes no entry and needs no new audit
   * action. That is how feature 022 claims "no audit change" (FR-018) and proves it here rather than
   * asserting it in prose. The companion guard is `libs/common/src/audit/catalogue.spec.ts`, which pins
   * the `access` class to an exact action list: adding one fails THERE, so this feature deliberately
   * writes no second guard for it.
   */
  it('classifies person_id as open — visible to a linear role, and invisible to the audit driver', () => {
    expect(FIELD_TIERS.person_id).toBe('open');
    expect(allowedFields('support_agent', { attachedToSubject: false }).has('person_id')).toBe(true);
    for (const role of Object.keys(ROLE_VISIBLE_TIERS)) {
      // `open` is never a maskable tier, so no role's read is upgraded to an audited reveal by it.
      expect(surfacedMaskableTiers(role, { attachedToSubject: false })).not.toContain('open');
    }
  });

  it('blocks mass export for a masked (linear) role, allows it above', () => {
    expect(canMassExportContacts('support_agent')).toBe(false);
    expect(canMassExportContacts('vip_support')).toBe(true);
    expect(canMassExportContacts('am')).toBe(true);
  });
});

/**
 * T003 (feature 031, ADR 0042) — may automatic distribution hand work to this role?
 *
 * ⚠️ Asserted by DERIVATION, not by listing names. A hardcoded expectation here would drift the first time
 * a role is added, and drift silently — which is the whole reason the predicate lives in this file.
 */
describe('isQueueRole — who automatic distribution may pick', () => {
  it('includes the roles that staff a queue', () => {
    expect(isQueueRole('support_agent')).toBe(true);
    expect(isQueueRole('vip_support')).toBe(true);
    expect(isQueueRole('teamlead')).toBe(true);
  });

  it('⚠️ excludes account managers — they work a portfolio, not a queue', () => {
    // A person may still hand them a conversation deliberately; what is forbidden is the MACHINE choosing.
    expect(isQueueRole('am')).toBe(false);
    expect(isQueueRole('shift_am')).toBe(false);
  });

  it('⚠️ excludes administrators too, and that is intended', () => {
    // They see every tier, `am_only` included. A router that could pick them would put a customer
    // conversation where nobody is watching for it.
    expect(isQueueRole('admin')).toBe(false);
    expect(isQueueRole('super_admin')).toBe(false);
  });

  it('⭐ is derived: exactly the known roles that do NOT see am_only', () => {
    const derived = Object.entries(ROLE_VISIBLE_TIERS)
      .filter(([, tiers]) => !tiers.includes('am_only'))
      .map(([role]) => role);
    // Positive control on the fixture: an empty map would satisfy every loop below.
    expect(derived.length).toBeGreaterThan(0);
    for (const role of derived) expect(isQueueRole(role)).toBe(true);
    for (const role of Object.keys(ROLE_VISIBLE_TIERS)) {
      if (!derived.includes(role)) expect(isQueueRole(role)).toBe(false);
    }
  });

  it('⚠️ an unknown or empty role is NOT a queue role — fail closed', () => {
    // Refusing to route to somebody unrecognised makes a person wait, and it is visible. Routing to them
    // leaves a customer conversation with somebody the system cannot describe.
    expect(isQueueRole('')).toBe(false);
    expect(isQueueRole('role_invented_next_year')).toBe(false);
  });

  it('⛔ never overlaps with the portfolio narrowing — a role is one or the other', () => {
    // The two predicates answer different questions off the same map; a role that was both would mean the
    // derivation had drifted.
    for (const role of Object.keys(ROLE_VISIBLE_TIERS)) {
      expect(isQueueRole(role) && narrowsToOwnPortfolio(role)).toBe(false);
    }
  });
});
