import { OverrideService } from '../src/rbac/override.service';
import { RoleDefaultsService } from '../src/rbac/role-defaults.service';
import { AuditRepository } from '../src/audit/audit.repository';
import type { PrismaService } from '../src/prisma.service';
import { makeFakePrisma } from './support/auth-test-doubles';

/**
 * T051 (feature 011, Polish) — RBAC management never logs PII/secrets, and the audit trail records
 * REFERENCES only (Principle IV / FR-013 / FR-023 / SEC-26/29). Drives personalize (grant+revoke) +
 * reset while capturing all console output; asserts the actor/target email never leaks and each
 * `AuditEntry.detail_json` carries only {scope, permissionKey, grant, roleKey} — never a value.
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
    const audit = new AuditRepository(prisma);
    const overrides = new OverrideService(prisma, audit, new RoleDefaultsService(prisma));

    const sinks = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const captured: string[] = [];
    const spies = sinks.map((s) =>
      jest.spyOn(console, s).mockImplementation((...a: unknown[]) => {
        captured.push(a.map(String).join(' '));
      }),
    );
    try {
      await overrides.personalizeUser('acct-A', { userId: 'god' }, 'u-1', 'reports.export', true);
      await overrides.personalizeUser('acct-A', { userId: 'god' }, 'u-1', 'crm.inbox.view', false);
      await overrides.resetToDefault('acct-A', { userId: 'god' }, { scope: 'user', userId: 'u-1' });
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    // Nothing sensitive reached the console.
    expect(captured.join('\n')).not.toContain('agent@secret.test');

    // Every audit row carries only references (no PII, no field values).
    //
    // Feature 015 added `affectedCount` to the privilege class: a group operation previously joined every
    // affected user id into `target_ref`, producing an unbounded string no index could serve and no reader
    // could scan. A count is still a reference-only value, and the allow-list in
    // `libs/common/src/audit/detail.ts` is what makes this set enforced rather than merely asserted here.
    const allowed = new Set(['scope', 'permissionKey', 'grant', 'roleKey', 'affectedCount']);
    expect(fake._tables.auditEntries.length).toBeGreaterThan(0);
    for (const row of fake._tables.auditEntries) {
      const detail = (row.detail_json ?? {}) as Record<string, unknown>;
      expect(Object.keys(detail).every((k) => allowed.has(k))).toBe(true);
      expect(JSON.stringify(row)).not.toContain('agent@secret.test');
    }
  });
});
