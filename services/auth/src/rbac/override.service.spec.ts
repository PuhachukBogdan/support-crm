import { OverrideService } from './override.service';
import { RoleDefaultsService } from './role-defaults.service';
import { RbacResolverService } from './resolver.service';
import { PrivilegeAuditService } from './privilege-audit.service';
import type { PrismaService } from '../prisma.service';
import type { Clock } from '../auth/ports/clock';
import { makeFakePrisma } from '../../tests/support/auth-test-doubles';

const CLOCK: Clock = { now: () => new Date('2026-07-21T00:00:00.000Z') };

function make(seed: Parameters<typeof makeFakePrisma>[0]) {
  const fake = makeFakePrisma(seed);
  const prisma = fake as unknown as PrismaService;
  const audit = new PrivilegeAuditService(prisma, CLOCK);
  const roleDefaults = new RoleDefaultsService(prisma);
  const overrides = new OverrideService(prisma, audit, roleDefaults);
  const resolver = new RbacResolverService(prisma);
  return { overrides, resolver, fake };
}

/**
 * US3 (feature 011, T027 / SC-002, SC-004). Copy-on-write: personalizing a user snapshots the role
 * defaults + applies the change → standalone; other users of the role are untouched; reset re-inherits.
 */
describe('OverrideService (copy-on-write)', () => {
  const baseSeed = {
    users: [{ id: 'u-1' }, { id: 'u-2' }],
    permissions: [{ key: 'crm.inbox.view' }, { key: 'reports.export' }],
    rolePermissions: [{ roleKey: 'support_agent', permKey: 'crm.inbox.view' }],
    userRoles: [
      { user_id: 'u-1', roleKey: 'support_agent' },
      { user_id: 'u-2', roleKey: 'support_agent' },
    ],
  };

  it('personalize snapshots the role + grants, and leaves other users unaffected (SC-002)', async () => {
    const { overrides, resolver, fake } = make(baseSeed);

    const res = await overrides.personalizeUser('acct-1', 'god', 'u-1', 'reports.export', true);

    expect(res.status).toBe('ok');
    const u1 = await resolver.resolve('acct-1', 'u-1');
    const u2 = await resolver.resolve('acct-1', 'u-2');
    expect(u1.mode).toBe('standalone');
    expect(u1.permissionKeys.sort()).toEqual(['crm.inbox.view', 'reports.export']); // snapshot + grant
    expect(u2.mode).toBe('inherited');
    expect(u2.permissionKeys).toEqual(['crm.inbox.view']); // untouched
    expect(fake._tables.privilegeAudits).toHaveLength(1);
  });

  it('revoke on a personalized user drops just that permission', async () => {
    const { overrides, resolver } = make(baseSeed);
    await overrides.personalizeUser('acct-1', 'god', 'u-1', 'reports.export', true);

    await overrides.personalizeUser('acct-1', 'god', 'u-1', 'crm.inbox.view', false);

    const u1 = await resolver.resolve('acct-1', 'u-1');
    expect(u1.permissionKeys).toEqual(['reports.export']);
  });

  it('reset re-inherits the live role default (SC-004)', async () => {
    const { overrides, resolver } = make(baseSeed);
    await overrides.personalizeUser('acct-1', 'god', 'u-1', 'reports.export', true);

    const res = await overrides.resetToDefault('acct-1', 'god', { scope: 'user', userId: 'u-1' });

    expect(res.status).toBe('ok');
    const u1 = await resolver.resolve('acct-1', 'u-1');
    expect(u1.mode).toBe('inherited');
    expect(u1.permissionKeys).toEqual(['crm.inbox.view']);
  });

  it('personalizing a user with no role → not_found', async () => {
    const { overrides } = make({
      users: [{ id: 'orphan' }],
      permissions: [{ key: 'crm.inbox.view' }],
    });
    const res = await overrides.personalizeUser('acct-1', 'god', 'orphan', 'crm.inbox.view', true);
    expect(res.status).toBe('not_found');
  });
});
