import { OverrideService } from '../src/rbac/override.service';
import { RoleDefaultsService } from '../src/rbac/role-defaults.service';
import { PrivilegeAuditService } from '../src/rbac/privilege-audit.service';
import type { PrismaService } from '../src/prisma.service';
import type { Clock } from '../src/auth/ports/clock';
import { makeFakePrisma } from './support/auth-test-doubles';

const CLOCK: Clock = { now: () => new Date('2026-07-21T00:00:00.000Z') };

/**
 * T052 (feature 011, Polish) — RBAC management writes are account-bound (Principle I / SC-011).
 * A mutation for account A stamps only account-A rows; a mutation for account B stamps only
 * account-B rows; neither crosses.
 *
 * Structural READ isolation (a query never returning another account's rows) is enforced by the
 * Prisma scoped-models extension (feature 007) and guaranteed by the data-model account-scope
 * coverage test (Permission / UserPermissionSet / PrivilegeAudit are enrolled in SCOPED_MODELS);
 * this spec proves the write-path account binding, which the account-agnostic fake can exercise.
 *
 * C2: per-license "separate company copy, no cross-company links" (FR-022) is a DEPLOYMENT property
 * (separate installs — infra Phase 13), not extra 011 code; here we prove per-account isolation.
 */
describe('RBAC management is account-isolated (Principle I / SC-011)', () => {
  it('personalize for account A stamps only A; for B only B; nothing crosses', async () => {
    const fake = makeFakePrisma({
      users: [
        { id: 'u-a', account_id: 'acct-A', status: 'active' },
        { id: 'u-b', account_id: 'acct-B', status: 'active' },
      ],
      permissions: [{ key: 'reports.export' }, { key: 'crm.inbox.view' }],
      rolePermissions: [{ roleKey: 'support_agent', permKey: 'crm.inbox.view' }],
      userRoles: [
        { user_id: 'u-a', roleKey: 'support_agent' },
        { user_id: 'u-b', roleKey: 'support_agent' },
      ],
    });
    const prisma = fake as unknown as PrismaService;
    const overrides = new OverrideService(
      prisma,
      new PrivilegeAuditService(prisma, CLOCK),
      new RoleDefaultsService(prisma),
    );

    await overrides.personalizeUser('acct-A', 'god-a', 'u-a', 'reports.export', true);
    await overrides.personalizeUser('acct-B', 'god-b', 'u-b', 'reports.export', true);

    // The standalone marker for each user carries its operating account — and does not cross.
    const setA = fake._tables.userPermissionSets.find((s) => s.user_id === 'u-a');
    const setB = fake._tables.userPermissionSets.find((s) => s.user_id === 'u-b');
    expect(setA?.account_id).toBe('acct-A');
    expect(setB?.account_id).toBe('acct-B');

    // Every privilege-audit row is stamped with its operating account; no A row targets B / vice versa.
    const auditsA = fake._tables.privilegeAudits.filter((a) => a.account_id === 'acct-A');
    const auditsB = fake._tables.privilegeAudits.filter((a) => a.account_id === 'acct-B');
    expect(auditsA).toHaveLength(1);
    expect(auditsB).toHaveLength(1);
    expect(auditsA[0]!.target_ref).toBe('u-a');
    expect(auditsB[0]!.target_ref).toBe('u-b');
    expect(
      fake._tables.privilegeAudits.every((a) => a.account_id === 'acct-A' || a.account_id === 'acct-B'),
    ).toBe(true);
  });
});
