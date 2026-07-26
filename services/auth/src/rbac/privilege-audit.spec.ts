import { OverrideService } from './override.service';
import { RoleDefaultsService } from './role-defaults.service';
import { PrivilegeAuditService } from './privilege-audit.service';
import type { PrismaService } from '../prisma.service';
import type { Clock } from '../auth/ports/clock';
import { makeFakePrisma } from '../../tests/support/auth-test-doubles';

const CLOCK: Clock = { now: () => new Date('2026-07-21T00:00:00.000Z') };

/**
 * US3 (feature 011, T031 / FR-013, SC-007). Every management mutation writes a PrivilegeAudit row
 * capturing actor/action/target + non-PII detail (permission keys / scope) — never a value or secret.
 */
describe('PrivilegeAudit (no PII in the record)', () => {
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
      new PrivilegeAuditService(prisma, CLOCK),
      new RoleDefaultsService(prisma),
    );

    await overrides.personalizeUser('acct-1', 'god', 'u-1', 'reports.export', true);

    const rows = fake._tables.privilegeAudits;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.actor_user_id).toBe('god');
    expect(row.action).toBe('perm_grant');
    expect(row.target_ref).toBe('u-1');
    // The whole serialized record must not leak an email/PII or a secret.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('agent@example.test');
    expect(serialized).toContain('reports.export'); // permission KEY is fine (not a value/secret)
  });
});
