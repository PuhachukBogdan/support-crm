import { OverrideService } from './override.service';
import { RoleDefaultsService } from './role-defaults.service';
import { AuditRepository } from '../audit/audit.repository';
import type { PrismaService } from '../prisma.service';
import { makeFakePrisma } from '../../tests/support/auth-test-doubles';

/**
 * US3 (feature 011, T031 / FR-013, SC-007). Every management mutation writes an audit row capturing
 * actor/action/target + non-PII detail (permission keys / scope) — never a value or secret.
 *
 * Feature 015 absorbed `PrivilegeAudit` into the unified trail: the guarantee is unchanged, the action name
 * is now the catalogue value (`permission.grant`, not `perm_grant`) and the row lives in `AuditEntry`. This
 * spec deliberately keeps its original intent — it is one of the gates on that absorption.
 */
describe('privilege changes are audited (no PII in the record)', () => {
  it('records a personalize with keys/scope only — no values, no PII', async () => {
    const fake = makeFakePrisma({
      users: [{ id: 'u-1', email: 'agent@example.test' }],
      permissions: [{ key: 'reports.export' }, { key: 'crm.inbox.view' }],
      rolePermissions: [{ roleKey: 'support_agent', permKey: 'crm.inbox.view' }],
      userRoles: [{ user_id: 'u-1', roleKey: 'support_agent' }],
    });
    const prisma = fake as unknown as PrismaService;
    const overrides = new OverrideService(
      prisma,
      new AuditRepository(prisma),
      new RoleDefaultsService(prisma),
    );

    await overrides.personalizeUser('acct-1', { userId: 'god' }, 'u-1', 'reports.export', true);

    const rows = fake._tables.auditEntries;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actor_user_id).toBe('god');
    expect(row.action).toBe('permission.grant');
    expect(row.target_ref).toBe('u-1');
    // The whole serialized record must not leak an email/PII or a secret.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('agent@example.test');
    expect(serialized).toContain('reports.export'); // permission KEY is fine (not a value/secret)
  });
});
