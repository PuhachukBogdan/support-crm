import { AuditDetailError, DETAIL_KEYS, parseDetail } from './detail';

/**
 * T014 (feature 015) — the per-class detail allow-list. FAILS before the module exists, PASSES after.
 *
 * This module exists because "don't put PII in the audit detail" is a code-review rule, and code-review
 * rules hold until the third feature writes into the field under a deadline. An allow-list makes the safe
 * thing the ONLY EXPRESSIBLE thing — the same reasoning that made feature 013's action vocabulary and
 * feature 014's trigger set closed rather than free-form.
 *
 * It matters more here than anywhere else in the product: these are the rows that *describe* PII access, so
 * a leak here would put the protected values next to a record of who wanted them.
 */
describe('DETAIL_KEYS — one allow-list per class', () => {
  it('declares keys for every class that has a writer', () => {
    for (const cls of ['privilege', 'deletion', 'access', 'export', 'assignment', 'retention']) {
      expect(DETAIL_KEYS[cls as keyof typeof DETAIL_KEYS]).toBeDefined();
    }
  });
});

describe('parseDetail — the documented keys are accepted', () => {
  it('privilege: exactly what the feature-011 store already carried, plus a group count', () => {
    expect(
      parseDetail('permission.grant', {
        scope: 'user',
        permissionKey: 'crm.labels.manage',
        grant: true,
      }),
    ).toEqual({ scope: 'user', permissionKey: 'crm.labels.manage', grant: true });

    // Group operations previously joined ids into `target_ref`; a count is both smaller and more useful.
    expect(parseDetail('permission.reset', { scope: 'group', affectedCount: 4 })).toEqual({
      scope: 'group',
      affectedCount: 4,
    });
  });

  it('deletion: the rule’s own name (operator-authored, not customer data) and its revision', () => {
    expect(parseDetail('automation.delete', { name: 'seed-keyword-triage', revision: 3 })).toEqual({
      name: 'seed-keyword-triage',
      revision: 3,
    });
  });

  it('access: the tier surfaced, never a value', () => {
    expect(parseDetail('contact.reveal', { tier: 'masked_pii' })).toEqual({ tier: 'masked_pii' });
  });

  it('access: an audit read records WHICH fields were filtered on, not their values', () => {
    expect(parseDetail('audit.read', { filters: ['actorUserId', 'action'] })).toEqual({
      filters: ['actorUserId', 'action'],
    });
  });

  it('accepts an absent / empty detail', () => {
    expect(parseDetail('permission.reset', undefined)).toBeUndefined();
    expect(parseDetail('permission.reset', {})).toBeUndefined();
  });
});

describe('parseDetail — an unknown key is refused', () => {
  it.each([
    ['privilege', 'permission.grant', { permissionKey: 'x', note: 'because he asked' }],
    ['deletion', 'automation.delete', { name: 'r', body: 'the rule text' }],
    ['access', 'contact.reveal', { tier: 'masked_pii', email: 'a@b.test' }],
    ['export', 'export.create', { format: 'csv', rows: [['a']] }],
  ])('%s: refuses a key outside its allow-list', (_cls, action, detail) => {
    expect(() => parseDetail(action as never, detail)).toThrow(AuditDetailError);
  });

  // A key valid for ANOTHER class is still refused — the allow-list is per class, not a union.
  it('refuses a key that belongs to a different class', () => {
    expect(() => parseDetail('contact.reveal', { permissionKey: 'crm.labels.manage' })).toThrow(
      AuditDetailError,
    );
    expect(() => parseDetail('permission.grant', { tier: 'masked_pii' })).toThrow(AuditDetailError);
  });
});

describe('parseDetail — a PII-shaped VALUE is refused, whatever the key', () => {
  // The allow-list constrains keys; this constrains values. Both are needed: `name` is a legitimate key on
  // a deletion, and someone could still put a player's email in it.
  it.each([
    'someone@example.test',
    'user＠example.test',
    '+34 600 123 456',
    '+1-555-0100',
    '4111 1111 1111 1111',
  ])('refuses the PII-shaped value %p', (value) => {
    expect(() => parseDetail('automation.delete', { name: value })).toThrow(AuditDetailError);
  });

  it('refuses a long free-text blob (a message body in disguise)', () => {
    expect(() => parseDetail('automation.delete', { name: 'x'.repeat(300) })).toThrow(AuditDetailError);
  });

  it('refuses a nested object or a deep array — a detail is flat by contract', () => {
    expect(() => parseDetail('automation.delete', { name: { nested: 'no' } as never })).toThrow(
      AuditDetailError,
    );
    expect(() => parseDetail('audit.read', { filters: [['nested'] as never] })).toThrow(
      AuditDetailError,
    );
  });

  it('accepts ordinary short identifiers and enum-like tokens', () => {
    expect(parseDetail('automation.delete', { name: 'seed-keyword-triage', revision: 2 })).toEqual({
      name: 'seed-keyword-triage',
      revision: 2,
    });
    expect(
      parseDetail('player.assign', {
        selfAssigned: true,
        managerRef: 'seed-user-0000-0000-000000000001',
      }),
    ).toEqual({ selfAssigned: true, managerRef: 'seed-user-0000-0000-000000000001' });
  });
});

describe('parseDetail — an unknown action is refused before its detail is even considered', () => {
  it.each(['perm_grant', 'permission.granted', '', undefined])('refuses the action %p', (action) => {
    expect(() => parseDetail(action as never, { scope: 'user' })).toThrow(AuditDetailError);
  });
});
