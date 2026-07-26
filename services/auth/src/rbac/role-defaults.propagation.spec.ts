import { RoleDefaultsService } from './role-defaults.service';
import { RbacResolverService } from './resolver.service';
import type { PrismaService } from '../prisma.service';
import { makeFakePrisma } from '../../tests/support/auth-test-doubles';

/**
 * US3 (feature 011, T029 / SC-003). A whole-role template edit propagates to INHERITED users
 * immediately, but a STANDALONE (personalized) user is frozen and does NOT see it until reset.
 */
describe('role-default propagation', () => {
  it('a template edit changes inherited users but not standalone ones', async () => {
    const prisma = makeFakePrisma({
      users: [{ id: 'inh' }, { id: 'std' }],
      permissions: [{ key: 'crm.inbox.view' }, { key: 'reports.export' }],
      rolePermissions: [{ roleKey: 'support_agent', permKey: 'crm.inbox.view' }],
      userRoles: [
        { user_id: 'inh', roleKey: 'support_agent' },
        { user_id: 'std', roleKey: 'support_agent' },
      ],
      // 'std' was personalized earlier (snapshot of the then-default), now standalone.
      userPermissionSets: [{ user_id: 'std', mode: 'standalone' }],
      userPermissionEntries: [{ user_id: 'std', permKey: 'crm.inbox.view' }],
    }) as unknown as PrismaService;
    const roleDefaults = new RoleDefaultsService(prisma);
    const resolver = new RbacResolverService(prisma);

    await roleDefaults.setRoleDefault('acct-1', 'support_agent', 'reports.export', true);

    const inh = await resolver.resolve('acct-1', 'inh');
    const std = await resolver.resolve('acct-1', 'std');

    expect(inh.permissionKeys.sort()).toEqual(['crm.inbox.view', 'reports.export']); // propagated
    expect(std.permissionKeys).toEqual(['crm.inbox.view']); // frozen (standalone)
  });
});
