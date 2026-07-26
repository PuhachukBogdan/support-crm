import { RoleDefaultsService } from './role-defaults.service';
import type { PrismaService } from '../prisma.service';
import { makeFakePrisma } from '../../tests/support/auth-test-doubles';
import { ROLE_DEFAULTS } from './catalogue';

/**
 * US2 (feature 011, T021). A role resolves to its seeded default (template) permission set; the
 * whole-role edit (SetRoleDefault) adds/removes a template permission and reports the affected users.
 */
describe('RoleDefaultsService', () => {
  it('resolves a role to its default permission set', async () => {
    const prisma = makeFakePrisma({
      permissions: [{ key: 'crm.inbox.view' }, { key: 'crm.contact.view' }, { key: 'reports.export' }],
      rolePermissions: [
        { roleKey: 'vip_support', permKey: 'crm.inbox.view' },
        { roleKey: 'vip_support', permKey: 'crm.contact.view' },
      ],
    }) as unknown as PrismaService;
    const svc = new RoleDefaultsService(prisma);

    const keys = await svc.list('acct-1', 'vip_support');

    expect(keys?.sort()).toEqual(['crm.contact.view', 'crm.inbox.view']);
  });

  it('setRoleDefault grants a permission to the role template + returns affected users', async () => {
    const prisma = makeFakePrisma({
      permissions: [{ key: 'crm.inbox.view' }, { key: 'reports.export' }],
      rolePermissions: [{ roleKey: 'support_agent', permKey: 'crm.inbox.view' }],
      userRoles: [{ user_id: 'u-1', roleKey: 'support_agent' }, { user_id: 'u-2', roleKey: 'support_agent' }],
    }) as unknown as PrismaService;
    const svc = new RoleDefaultsService(prisma);

    const res = await svc.setRoleDefault('acct-1', 'support_agent', 'reports.export', true);

    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.affectedUserIds.sort()).toEqual(['u-1', 'u-2']);
    expect((await svc.list('acct-1', 'support_agent'))?.sort()).toEqual([
      'crm.inbox.view',
      'reports.export',
    ]);
  });

  it('setRoleDefault on a missing role → not_found', async () => {
    const prisma = makeFakePrisma({}) as unknown as PrismaService;
    const svc = new RoleDefaultsService(prisma);
    const res = await svc.setRoleDefault('acct-1', 'nope', 'x', true);
    expect(res.status).toBe('not_found');
  });

  it('catalogue matrix: only super_admin holds platform.role.manage (FR-018)', () => {
    for (const [role, keys] of Object.entries(ROLE_DEFAULTS)) {
      const holds = keys.includes('platform.role.manage');
      expect(holds).toBe(role === 'super_admin');
    }
  });
});
