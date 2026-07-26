import { OverrideService } from '../src/rbac/override.service';
import { RoleDefaultsService } from '../src/rbac/role-defaults.service';
import { PrivilegeAuditService } from '../src/rbac/privilege-audit.service';
import type { PrismaService } from '../src/prisma.service';
import type { Clock } from '../src/auth/ports/clock';
import { makeFakePrisma } from './support/auth-test-doubles';

const CLOCK: Clock = { now: () => new Date('2026-07-21T00:00:00.000Z') };

/**
 * T051 (feature 011, Polish) — RBAC management never logs PII/secrets, and the audit trail records
 * REFERENCES only (Principle IV / FR-013 / FR-023 / SEC-26/29). Drives personalize (grant+revoke) +
 * reset while capturing all console output; asserts the actor/target email never leaks and each
 * `PrivilegeAudit.detail_json` carries only {scope, permissionKey, grant, roleKey} — never a value.
 */
describe('RBAC management leaks no PII/secret; audit is references-only (FR-013/023)', () => {
  it('captures management output and finds no PII; audit detail is reference-only', async () => {
    const fake = makeFakePrisma({
      users: [{ id: 'u-1', account_id: 'acct-A', email: 'agent@secret.test', status: 'active' }],
      permissions: [{ key: 'crm.inbox.view' }, { key: 'reports.export' }],
      rolePermissions: [{ roleKey: 'support_agent', permKey: 'crm.inbox.view' }],
      userRoles: [{ user_id: 'u-1', roleKey: 'support_agent' }],
    });
    const prisma = fake as unknown as PrismaService;
    const audit = new PrivilegeAuditService(prisma, CLOCK);
    const overrides = new OverrideService(prisma, audit, new RoleDefaultsService(prisma));

    const sinks = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const captured: string[] = [];
    const spies = sinks.map((s) =>
      jest.spyOn(console, s).mockImplementation((...a: unknown[]) => {
        captured.push(a.map(String).join(' '));
      }),
    );
    try {
      await overrides.personalizeUser('acct-A', 'god', 'u-1', 'reports.export', true);
      await overrides.personalizeUser('acct-A', 'god', 'u-1', 'crm.inbox.view', false);
      await overrides.resetToDefault('acct-A', 'god', { scope: 'user', userId: 'u-1' });
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    // Nothing sensitive reached the console.
    expect(captured.join('\n')).not.toContain('agent@secret.test');

    // Every audit row carries only references (no PII, no field values).
    const allowed = new Set(['scope', 'permissionKey', 'grant', 'roleKey']);
    expect(fake._tables.privilegeAudits.length).toBeGreaterThan(0);
    for (const row of fake._tables.privilegeAudits) {
      const detail = (row.detail_json ?? {}) as Record<string, unknown>;
      expect(Object.keys(detail).every((k) => allowed.has(k))).toBe(true);
      expect(JSON.stringify(row)).not.toContain('agent@secret.test');
    }
  });
});
