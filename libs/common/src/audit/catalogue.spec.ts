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
  it('covers every class ADR 0019 names, plus the 0032 extension', () => {
    // exports · permission/role changes · deletions · access to customer records (0019)
    // + player↔AM assignment changes (0032/SEC-AP3) + retention (whatever can delete history)
    expect([...AUDIT_CLASSES].sort()).toEqual(
      ['access', 'assignment', 'deletion', 'export', 'privilege', 'retention'].sort(),
    );
  });

  it('every action resolves to a class and a writer', () => {
    for (const action of Object.keys(AUDIT_ACTIONS) as AuditAction[]) {
      expect(AUDIT_CLASSES).toContain(classOf(action));
      expect(writerOf(action).length).toBeGreaterThan(0);
    }
  });

  it('ships the actions whose writers exist today', () => {
    for (const action of [
      'role.assign',
      'role.revoke',
      'permission.grant',
      'permission.revoke',
      'permission.reset',
      'automation.delete',
      'contact.reveal',
      'audit.read',
      // Feature 017 (roadmap 4.10): written by `chats` inside the transaction that marks an export
      // `ready`. Its detail allow-list (format / rowCount / scope) is unchanged from 015 — and
      // `rowCount` is why: it is only knowable once the artefact exists, so this entry always
      // belonged at completion. 015 had the timing right and the writer wrong.
      'export.create',
    ] as AuditAction[]) {
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
      ['player.assign', 'no-writer-yet'], // roadmap 5.7
      ['player.unassign', 'no-writer-yet'], // roadmap 5.7
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
        'player.assign',
        'player.unassign',
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
      ].sort(),
    );
  });

  it('groups access (a reveal, a record open, and reading the log itself)', () => {
    expect(actionsOfClass('access').sort()).toEqual(
      ['contact.reveal', 'record.open', 'audit.read'].sort(),
    );
  });

  it('returns nothing for an unknown class rather than everything', () => {
    expect(actionsOfClass('nope' as never)).toEqual([]);
  });
});
