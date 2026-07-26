import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_ACTIONS } from './catalogue';
import {
  LEGACY_PRIVILEGE_ACTION,
  LEGACY_PRIVILEGE_ACTIONS,
  isLegacyMappingTotal,
  mapLegacyPrivilegeAction,
} from './legacy-mapping';

/**
 * T015 (feature 015) — the legacy action mapping. FAILS before the module exists, PASSES after.
 *
 * The migration that moves feature 011's rows cannot be unit tested — it is SQL, and it runs once against a
 * real database. What CAN be tested is the mapping it encodes. So this spec asserts the mapping is total and
 * lands on real catalogue actions, and then asserts the **SQL and this module agree** — because two copies
 * of a mapping that drift is how a migration silently mislabels history.
 */
describe('the mapping is total', () => {
  it('covers all six legacy action values', () => {
    expect(isLegacyMappingTotal()).toBe(true);
    for (const legacy of LEGACY_PRIVILEGE_ACTIONS) {
      expect(mapLegacyPrivilegeAction(legacy)).not.toBeNull();
    }
  });

  it('maps onto real catalogue actions, not invented strings', () => {
    for (const target of Object.values(LEGACY_PRIVILEGE_ACTION)) {
      expect(AUDIT_ACTIONS[target]).toBeDefined();
      expect(AUDIT_ACTIONS[target]!.class).toBe('privilege');
    }
  });

  it('returns null for anything that is not a legacy value (never a guess)', () => {
    for (const bad of ['permission.grant', 'role_delete', 'RESET', '', 'legacy.perm_grant']) {
      expect(mapLegacyPrivilegeAction(bad)).toBeNull();
    }
  });
});

describe('the collapse is deliberate', () => {
  // Asserted explicitly so it reads as a decision. A role change IS an assignment of the new role, and the
  // old role was never recorded — two names would imply a distinction the data cannot support.
  it('role_change and role_assign both become role.assign', () => {
    expect(mapLegacyPrivilegeAction('role_change')).toBe('role.assign');
    expect(mapLegacyPrivilegeAction('role_assign')).toBe('role.assign');
  });

  it('nothing else collapses — the other four are distinct', () => {
    const targets = ['role_revoke', 'perm_grant', 'perm_revoke', 'reset'].map((a) =>
      mapLegacyPrivilegeAction(a),
    );
    expect(new Set(targets).size).toBe(4);
  });
});

/**
 * The migration hardcodes the same six cases in SQL. Two copies of one mapping is how history gets silently
 * mislabelled, so they are compared here rather than trusted to review.
 */
describe('the SQL migration agrees with this module', () => {
  const sql = readFileSync(
    join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'services',
      'auth',
      'prisma',
      'migrations',
      '20260728000000_audit_entry',
      'migration.sql',
    ),
    'utf8',
  );

  it.each(LEGACY_PRIVILEGE_ACTIONS)('SQL maps %s to the same action', (legacy) => {
    const expected = mapLegacyPrivilegeAction(legacy)!;
    // e.g.  WHEN 'perm_grant'   THEN 'permission.grant'
    const pattern = new RegExp(`WHEN\\s+'${legacy}'\\s+THEN\\s+'${expected.replace('.', '\\.')}'`);
    expect(sql).toMatch(pattern);
  });

  it('copies rows BEFORE dropping the old table', () => {
    expect(sql.indexOf('FROM "PrivilegeAudit"')).toBeLessThan(sql.indexOf('DROP TABLE "PrivilegeAudit"'));
  });

  it('preserves an unmapped legacy value instead of dropping the row', () => {
    // A row nobody planned for must be visible to a reader, not silently absent.
    expect(sql).toMatch(/ELSE\s+'legacy\.'\s*\|\|\s*"action"/);
  });

  it('carries detail_json over unchanged (it was already values-free)', () => {
    expect(sql).toContain('"detail_json"');
  });
});
