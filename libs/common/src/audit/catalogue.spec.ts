import {
  AUDIT_ACTIONS,
  AUDIT_CLASSES,
  actionsOfClass,
  classOf,
  isAuditAction,
  writerOf,
  type AuditAction,
} from './catalogue';

/**
 * T013 (feature 015) — the closed action catalogue. FAILS before the module exists, PASSES after.
 *
 * Why a catalogue rather than free text: an audit log is read *years* after it is written, usually by
 * someone who was not there. Free-text actions make it unqueryable — every reader has to know every
 * spelling anyone ever used ("perm_grant", "permission granted", "grantPermission"). A closed vocabulary
 * refused at write time is what keeps "show me every permission change" answerable.
 *
 * This is the same discipline as feature 011's permission catalogue and feature 014's trigger catalogue,
 * for the same reason.
 */
describe('AUDIT_ACTIONS — the v1 vocabulary', () => {
  it('covers every class ADR 0019 names, plus 0032, 036’s lifecycle and 038’s staffing', () => {
    // exports · permission/role changes · deletions · access to customer records (0019)
    // + player↔AM assignment changes (0032/SEC-AP3) + retention (whatever can delete history)
    // + lifecycle (W27/036: WHERE a conversation is — the shelf's four verbs; not a deletion,
    //   because a shelved conversation exists, keeps its history and comes back)
    // + staffing (W31/038: acts upon a colleague's ACCOUNT by a machine holding a key — hiring,
    //   offboarding, the work handover and every refusal; the one class whose actor is not a person)
    expect([...AUDIT_CLASSES].sort()).toEqual(
      ['access', 'assignment', 'deletion', 'export', 'lifecycle', 'privilege', 'retention', 'staffing'].sort(),
    );
  });

  /**
   * The live set, stated once. Both the exact-membership check and the per-action check read it, so an
   * action cannot become live — by promotion OR by being born that way — without editing this list.
   */
  const LIVE_ACTIONS: AuditAction[] = [
    'role.assign',
    'role.revoke',
    'permission.grant',
    'permission.revoke',
    'permission.reset',
    // Feature 037 (W30): the field/form/option-set authoring surface writes these three.
    'field.config_changed',
    'option_set.config_changed',
    'form.config_changed',
    // ⭐ Feature 038 (W31): the provisioning key's lifecycle and the machine path's four acts.
    // Every one ships with its writer — the `channel.intake_refused` lesson (live, unwritten).
    'api_key.issued',
    'api_key.rotated',
    'api_key.revoked',
    'provisioning.create',
    'provisioning.deactivate',
    'provisioning.rejected',
    'staff.handover',
    'automation.delete',
    'contact.reveal',
    'audit.read',
    // Feature 017 (roadmap 4.10): written by `chats` inside the transaction that marks an export
    // `ready`. Its detail allow-list (format / rowCount / scope) is unchanged from 015 — and
    // `rowCount` is why: it is only knowable once the artefact exists, so this entry always
    // belonged at completion. 015 had the timing right and the writer wrong.
    'export.create',
    // Feature 020 (roadmap 5.2): two records recognised as one person, and the reverse. Written by
    // `users` at the moment the link is made — automatically, on a matching email or phone — which is
    // exactly why it needs an entry: an automatic decision with no record of itself is only visible
    // later, as a customer card that quietly contains someone else.
    'player.link',
    'player.unlink',
    // ⭐ W27 / 036 (9.16): the shelf's four verbs — written by `chats` inside the shelf write's own
    // transaction. Criterion ④ in entry form: the DELETE removes a conversation from every list and
    // removes nothing from this trail, and these four rows are what make that checkable.
    'conversation.suspend',
    'conversation.release',
    'conversation.delete',
    'conversation.restore',
    // ⭐ W29 (R46): macro deletion — the trail keeps the name the row no longer has.
    'macro.delete',
    // Feature 024 (roadmap 5.3, ADR 0039): groups. All seven are `privilege`, because adding someone
    // to a group GRANTS ACCESS — that is the premise of the whole decision, and filing them anywhere
    // else would split "who gained rights, and how?" across two filters.
    'group.create',
    'group.rename',
    'group.routability_changed',
    'group.delete',
    'group_member.add',
    'group_member.remove',
    'group_permission.grant',
    'group_permission.revoke',
    // Feature 025 (roadmap 5.9). Only the OVERRIDE — changing one's own presence writes no audit
    // entry, deliberately, and `presence.override` is therefore the whole of this feature's
    // footprint in this catalogue.
    'presence.override',
    // Feature 026 (roadmap 5.7). Reserved by 015 for exactly this feature; the writer is `users`.
    // ⚠️ Weightier than the class name suggests: ATTACHMENT GRANTS ACCESS, and self-assignment makes
    // these entries the stated price of the capability rather than a record of it.
    'player.assign',
    'player.unassign',
    'conversation.unroutable',
    // ⭐ Feature 032 (roadmap 4.16 — R22). A supervisor moved a conversation to another brand. Written by
    // `chats`, inside the update's own transaction. Class `assignment` beside `player.link`: both are
    // statements about WHICH RECORD a thing belongs to, and brand drives reporting and record identity
    // even though ADR 0038 keeps it out of authorization.
    'conversation.brand_changed',
    // ── Feature 033 (roadmap 6.1/6.4/6.5/6.6) — the first audited acts with NO HUMAN ACTOR ──
    //
    // A stranger's delivery, a mailbox, a retry. There is no operator to name, which is exactly why they
    // are recorded: intake is the only place in the product where something happens because an outsider
    // asked for it. All four are written by `chats`, and all four are expressible without a contact
    // value — the `assignment` class's allow-list already permits a bare identifier KIND, the shape
    // feature 020 established for `player.link`, so no allow-list change was needed for these either.
    'channel.intake_refused',
    'channel.identity_resolved',
    // Audited AS WELL AS recorded as a transition: the transition is the history a person reads, this is
    // the accountability record for a state change nobody authorised.
    'conversation.reopened_by_reply',
    // The refusal most easily mistaken for success — an unsent message and a delivered one look the same
    // from inside the product, and the customer's silence is the only symptom.
    'channel.send_refused',
    // ⭐ W15 (roadmap 6.8 minimum, subpoint 3.10) — the first channel action whose actor IS a person:
    // an admin created or changed a channel row. Audited because that row decides which tenant and
    // brand an arriving delivery belongs to; written by `chats` inside the upsert's own transaction.
    'channel.config_changed',
    // ⭐ W15a (subpoint 3.14) — an admin created or changed a status definition. A status's category
    // decides which bucket and report a ticket appears in; retiring one changes what agents may set.
    'status.config_changed',
    // ── W9 / spec 035 (ADR 0044 §4/§5) — the anti-pitching inversion and its reversible pair ──
    // `contact.lookup` records EVERY attempt (found / none / ambiguous / rate_capped) with the
    // salted HASH of the searched value — the trail is the anomaly signal, so a refused attempt is
    // still a data point. The attach/detach pair carries {playerRef, brandRef} — ids, the PAIR,
    // never a contact. All three written with the caller's own identity; no system actor.
    'contact.lookup',
    'conversation.player_attach',
    'conversation.player_detach',
  ];

  it('every action resolves to a class and a writer', () => {
    for (const action of Object.keys(AUDIT_ACTIONS) as AuditAction[]) {
      expect(AUDIT_CLASSES).toContain(classOf(action));
      expect(writerOf(action).length).toBeGreaterThan(0);
    }
  });

  /**
   * ⚠️ **This assertion is an EXACT membership check since feature 020, and it was not before.**
   *
   * It used to iterate a declared list and assert each entry is `live` — which proves those actions are
   * live and says nothing about the ones that are not listed. So a brand-new action added straight to
   * the catalogue as `live` slipped past every guard here, while the catalogue's own header promises
   * *"a spec asserts the exact membership of each, so promoting one is a visible act rather than a quiet
   * one"*. That held for a PROMOTION (which changes the non-live set below) and not for an ADDITION —
   * and an addition is the ordinary case from here on. Found by adding two and watching nothing fail.
   */
  it('ships EXACTLY the actions whose writers exist today', () => {
    const live = (Object.keys(AUDIT_ACTIONS) as AuditAction[]).filter(
      (a) => AUDIT_ACTIONS[a]!.status === 'live',
    );
    expect(live.sort()).toEqual(LIVE_ACTIONS.slice().sort());
  });

  it('every declared live action really is live', () => {
    for (const action of LIVE_ACTIONS) {
      expect(AUDIT_ACTIONS[action]!.status).toBe('live');
    }
  });

  // Defining these NOW is what stops the next feature from inventing its own store — which is exactly how
  // feature 011 ended up with two (PrivilegeAudit and ContactViewAudit).
  it('defines the classes whose writers arrive later, and MARKS them', () => {
    const pending: Array<[AuditAction, string]> = [
      // ['export.create', 'no-writer-yet'] — CLAIMED by feature 017 (roadmap 4.10). It is now `live`
      // with writer `chats`, and the assertion that it is live lives above with the other live rows.
      // This row is left as a comment on purpose: the point of this test is that a status change is a
      // visible edit, and deleting the line without trace would defeat it.
      // ['player.assign' / 'player.unassign', 'no-writer-yet'] — CLAIMED by feature 026 (roadmap
      // 5.7). Both are now `live` with writer `users`. Left as a comment for the same reason
      // `export.create` above is: the point of this test is that a status change is a VISIBLE edit,
      // and deleting the line without trace would defeat it.
      ['account.delete', 'no-writer-yet'], // SEC-41
      ['audit.trim', 'no-writer-yet'], // 7.3 + ADR 0015
      ['record.open', 'deferred'], // Q1 — ships WITH retention, not before
    ];
    for (const [action, status] of pending) {
      expect(AUDIT_ACTIONS[action]).toBeDefined();
      expect(AUDIT_ACTIONS[action]!.status).toBe(status);
    }
  });

  // If someone wires a writer for one of these, this test is where they find out they also owe a decision
  // (retention, in record.open's case) rather than shipping it quietly.
  it('an action marked no-writer-yet / deferred is not silently promoted', () => {
    const marked = (Object.keys(AUDIT_ACTIONS) as AuditAction[]).filter(
      (a) => AUDIT_ACTIONS[a]!.status !== 'live',
    );
    expect(marked.sort()).toEqual(
      [
        // `export.create` LEFT this list in feature 017 (roadmap 4.10) — it now has a live writer,
        // `chats`, which is also a correction of 015's guess (`worker`, a service with no database).
        // The move belongs in the same change as the catalogue edit, which is what this line is.
        // `player.assign` / `player.unassign` LEFT this list in feature 026 (roadmap 5.7) — the two
        // actions feature 015 reserved for exactly that feature now have their writer.
        'account.delete',
        'audit.trim',
        'record.open',
      ].sort(),
    );
  });

  // Whatever is able to delete audit history must itself be audited, or the single most sensitive act in
  // the subsystem is the one act with no record.
  it('includes audit.trim, so a future retention job cannot delete history unrecorded', () => {
    expect(AUDIT_ACTIONS['audit.trim']).toBeDefined();
    expect(classOf('audit.trim')).toBe('retention');
  });

  it('names actions as noun.verb, matching the permission-key convention', () => {
    for (const action of Object.keys(AUDIT_ACTIONS)) {
      expect(action).toMatch(/^[a-z][a-z_]*\.[a-z][a-z_]*$/);
    }
  });
});

describe('isAuditAction — unknown is refused, never defaulted', () => {
  it('accepts every catalogue action', () => {
    for (const action of Object.keys(AUDIT_ACTIONS)) expect(isAuditAction(action)).toBe(true);
  });

  it.each([
    'permission_grant', // the legacy spelling — must NOT be accepted on the new path
    'perm_grant',
    'PERMISSION.GRANT',
    'permission.granted',
    'something.else',
    '',
    undefined,
    null,
    42,
    'legacy.perm_grant', // the migration's escape hatch is storage-only, not a writable action
  ])('refuses %p', (value) => {
    expect(isAuditAction(value)).toBe(false);
  });
});

describe('actionsOfClass', () => {
  it('groups the privilege class exactly', () => {
    expect(actionsOfClass('privilege').sort()).toEqual(
      [
        'role.assign',
        'role.revoke',
        'permission.grant',
        'permission.revoke',
        'permission.reset',
        // ⭐ Feature 038 (W31): issuing a key that can mint staff accounts IS a grant of authority —
        // to a machine rather than a person, which is why it belongs beside the human grants.
        'api_key.issued',
        'api_key.rotated',
        'api_key.revoked',
        // Feature 024. Deleting a group is here rather than under `deletion` on purpose: what matters
        // about it is that every member LOSES the group's grants, not that a row went away.
        'group.create',
        'group.rename',
    'group.routability_changed',
        'group.delete',
        'group_member.add',
        'group_member.remove',
        'group_permission.grant',
        'group_permission.revoke',
        'presence.override',
      ].sort(),
    );
  });

  it('groups access (a reveal, a record open, reading the log — and W9’s lookup)', () => {
    expect(actionsOfClass('access').sort()).toEqual(
      ['contact.reveal', 'record.open', 'audit.read', 'contact.lookup'].sort(),
    );
  });

  it('returns nothing for an unknown class rather than everything', () => {
    expect(actionsOfClass('nope' as never)).toEqual([]);
  });
});
