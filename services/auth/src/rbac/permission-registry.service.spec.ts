import { PermissionRegistryService } from './permission-registry.service';
import { RoleDefaultsService } from './role-defaults.service';
import type { PrismaService } from '../prisma.service';
import { makeFakePrisma } from '../../tests/support/auth-test-doubles';

/**
 * US2 (feature 011, T020). The catalogue is grouped by category for the admin panel, and a
 * permission that no role's default template lists is OFF for that role (R-2 corollary).
 */
describe('PermissionRegistryService', () => {
  it('groups the catalogue by category', async () => {
    const prisma = makeFakePrisma({
      permissions: [
        { key: 'crm.inbox.view', category: 'crm' },
        { key: 'crm.contact.view', category: 'crm' },
        { key: 'analytics.dashboard.view', category: 'analytics' },
      ],
    }) as unknown as PrismaService;
    const registry = new PermissionRegistryService(prisma);

    const cats = await registry.listCatalogue('acct-1');

    const crm = cats.find((c) => c.category === 'crm');
    const analytics = cats.find((c) => c.category === 'analytics');
    expect(crm?.permissions.map((p) => p.key).sort()).toEqual(['crm.contact.view', 'crm.inbox.view']);
    expect(analytics?.permissions.map((p) => p.key)).toEqual(['analytics.dashboard.view']);
  });

  it('a permission listed in the catalogue but not granted is OFF for the role (corollary)', async () => {
    const prisma = makeFakePrisma({
      permissions: [{ key: 'crm.inbox.view' }, { key: 'reports.export' }],
      rolePermissions: [{ roleKey: 'support_agent', permKey: 'crm.inbox.view' }],
    }) as unknown as PrismaService;
    const roleDefaults = new RoleDefaultsService(prisma);

    const keys = await roleDefaults.list('acct-1', 'support_agent');

    expect(keys).toEqual(['crm.inbox.view']);
    expect(keys).not.toContain('reports.export');
  });
});
