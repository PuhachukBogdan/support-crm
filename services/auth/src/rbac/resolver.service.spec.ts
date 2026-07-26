import { RbacResolverService } from './resolver.service';
import type { PrismaService } from '../prisma.service';
import { makeFakePrisma } from '../../tests/support/auth-test-doubles';

/**
 * US1 (feature 011, T012). The resolver returns a user's EFFECTIVE permission set: the role
 * default for an inherited user, the snapshot for a standalone user, and nothing (deny-by-default)
 * for a user with no role. Prisma is the in-memory fake (Track A) driven through `forAccount`.
 */
function makeResolver(seed: Parameters<typeof makeFakePrisma>[0]) {
  const prisma = makeFakePrisma(seed);
  const resolver = new RbacResolverService(prisma as unknown as PrismaService);
  return { resolver, prisma };
}

describe('RbacResolverService.resolve', () => {
  it('INHERITED: returns the role default permission set', async () => {
    const { resolver } = makeResolver({
      users: [{ id: 'u-1', account_id: 'acct-1' }],
      userRoles: [{ user_id: 'u-1', roleKey: 'support_agent' }],
      permissions: [{ key: 'tickets.view' }, { key: 'tickets.reply' }, { key: 'settings.manage' }],
      rolePermissions: [
        { roleKey: 'support_agent', permKey: 'tickets.view' },
        { roleKey: 'support_agent', permKey: 'tickets.reply' },
      ],
    });

    const r = await resolver.resolve('acct-1', 'u-1');

    expect(r.roleKey).toBe('support_agent');
    expect(r.mode).toBe('inherited');
    expect(r.permissionKeys.sort()).toEqual(['tickets.reply', 'tickets.view']);
    expect(r.permissionKeys).not.toContain('settings.manage');
    expect(r.isPreview).toBe(false);
    expect(r.readOnly).toBe(false);
  });

  it('NO ROLE: resolves to empty (deny-by-default, FR-012)', async () => {
    const { resolver } = makeResolver({ users: [{ id: 'u-2', account_id: 'acct-1' }] });

    const r = await resolver.resolve('acct-1', 'u-2');

    expect(r.permissionKeys).toEqual([]);
    expect(r.roleKey).toBe('');
    expect(r.mode).toBe('inherited');
  });

  it('STANDALONE: returns the personalized snapshot, not the role default', async () => {
    const { resolver } = makeResolver({
      users: [{ id: 'u-3', account_id: 'acct-1' }],
      userRoles: [{ user_id: 'u-3', roleKey: 'support_agent' }],
      permissions: [{ key: 'tickets.view' }, { key: 'reports.export' }],
      rolePermissions: [{ roleKey: 'support_agent', permKey: 'tickets.view' }],
      userPermissionSets: [{ user_id: 'u-3', mode: 'standalone' }],
      userPermissionEntries: [{ user_id: 'u-3', permKey: 'reports.export' }],
    });

    const r = await resolver.resolve('acct-1', 'u-3');

    expect(r.mode).toBe('standalone');
    expect(r.permissionKeys).toEqual(['reports.export']);
  });

  it('PREVIEW: marks the result read-only when a preview role is supplied (US5 seam)', async () => {
    const { resolver } = makeResolver({
      users: [{ id: 'u-4', account_id: 'acct-1' }],
      userRoles: [{ user_id: 'u-4', roleKey: 'super_admin' }],
    });

    const r = await resolver.resolve('acct-1', 'u-4', 'support_agent');

    expect(r.isPreview).toBe(true);
    expect(r.readOnly).toBe(true);
  });
});
