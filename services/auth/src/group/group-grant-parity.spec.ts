import { GroupGrpcController, GROUP_MANAGE_KEY } from './group.grpc.controller';
import { GroupService } from './group.service';
import { RbacGrpcController } from '../rbac/rbac.grpc.controller';
import { RbacResolverService } from '../rbac/resolver.service';
import { PermissionRegistryService } from '../rbac/permission-registry.service';
import { RoleDefaultsService } from '../rbac/role-defaults.service';
import { OverrideService } from '../rbac/override.service';
import { RoleAssignmentService } from '../rbac/role-assignment.service';
import { AuditRepository } from '../audit/audit.repository';
import type { PrismaService } from '../prisma.service';
import { makeFakePrisma, type FakeSeed } from '../../tests/support/auth-test-doubles';

/**
 * FR-015 (feature 024) — **a group must not become a side door to a capability that could not be
 * handed over directly.**
 *
 * ⚠️ THIS SPEC EXISTS BECAUSE THE FIRST DRAFT OF THIS FEATURE HAD THE HOLE IT DESCRIBES. Managing
 * groups is `platform.group.manage`, and `admin` holds it through `ALL_KEYS`. Granting a permission
 * to a group was, briefly, a way for an `admin` to obtain `platform.role.manage` — a **super-admin
 * exclusive that the role matrix deliberately withholds from them** (011 FR-018 / ADR 0034):
 *
 *     create a group  →  grant it platform.role.manage  →  add yourself to the group
 *
 * Three calls, each individually permitted, ending in a privilege nobody meant to give. It is the
 * shape ADR 0039 §2 warns about arriving through the back: not a second policy layer, but a second
 * ROUTE into the first one.
 *
 * The rule that closes it is stated as PARITY rather than as a new invention, so it keeps holding if
 * ADR 0034 later changes the underlying escalation rule deliberately: a caller may confer only what
 * they already hold, which makes the group path strictly no more powerful than the caller is. The
 * direct path (PersonalizeUser) is super-admin-only and a super-admin holds everything, so the two
 * agree wherever they overlap and the group path can never exceed the direct one.
 */
const ROLE_MANAGE = 'platform.role.manage';
const INBOX = 'crm.inbox.view';

/** An `admin`: everything except the two super-admin exclusives — the real role matrix, in miniature. */
const ADMIN_SEED: FakeSeed = {
  users: [{ id: 'admin-1' }, { id: 'victim' }],
  userRoles: [{ user_id: 'admin-1', roleKey: 'admin' }, { user_id: 'victim', roleKey: 'support_agent' }],
  permissions: [
    { key: GROUP_MANAGE_KEY, category: 'platform' },
    { key: ROLE_MANAGE, category: 'platform' },
    { key: INBOX },
  ],
  rolePermissions: [
    { roleKey: 'admin', permKey: GROUP_MANAGE_KEY },
    { roleKey: 'admin', permKey: INBOX },
    // NOT platform.role.manage — that is the point.
    { roleKey: 'support_agent', permKey: INBOX },
  ],
  groups: [{ name: 'A' }],
};

const CALLER = { callerAccountId: 'acct-1', callerUserId: 'admin-1', callerRoles: ['admin'] };

function make(seed: FakeSeed) {
  const prisma = makeFakePrisma(seed) as unknown as PrismaService;
  const audit = new AuditRepository(prisma);
  const resolver = new RbacResolverService(prisma);
  const roleDefaults = new RoleDefaultsService(prisma);
  const groups = new GroupGrpcController(new GroupService(prisma, audit), resolver);
  const rbac = new RbacGrpcController(
    resolver,
    new PermissionRegistryService(prisma),
    roleDefaults,
    new OverrideService(prisma, audit, roleDefaults),
    new RoleAssignmentService(prisma, audit),
  );
  return { groups, rbac, resolver };
}

describe('granting through a group cannot exceed granting directly', () => {
  it('an admin CANNOT confer a key they do not hold', async () => {
    const { groups } = make(ADMIN_SEED);
    const r = await groups.setGroupPermissionRpc({
      ...CALLER,
      groupId: 'group-A',
      permissionKey: ROLE_MANAGE,
      grant: true,
    });
    // A distinct status, not a flat FORBIDDEN: they MAY manage groups. What they may not do is give
    // away something they were never given.
    expect(r.status).toBe('GROUP_STATUS_ESCALATION');
  });

  it('and the direct route is closed to them too — the two paths AGREE', async () => {
    const { rbac } = make(ADMIN_SEED);
    const r = await rbac.personalizeUserRpc({
      ...CALLER,
      userId: 'victim',
      permissionKey: ROLE_MANAGE,
      grant: true,
    });
    expect(r.status).toBe('RBAC_STATUS_FORBIDDEN');
  });

  it('the escalation attempt writes nothing and audits nothing', async () => {
    const prisma = makeFakePrisma(ADMIN_SEED) as unknown as PrismaService;
    const groups = new GroupGrpcController(
      new GroupService(prisma, new AuditRepository(prisma)),
      new RbacResolverService(prisma),
    );
    await groups.setGroupPermissionRpc({
      ...CALLER,
      groupId: 'group-A',
      permissionKey: ROLE_MANAGE,
      grant: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = (prisma as any)._tables;
    expect(t.groupPermissions).toHaveLength(0);
    expect(t.auditEntries).toHaveLength(0);
  });

  it('the full three-step attack is closed at its middle step', async () => {
    const { groups, resolver } = make(ADMIN_SEED);
    await groups.createGroupRpc({ ...CALLER, name: 'Backdoor' });
    const created = await groups.listGroupsRpc({ accountId: 'acct-1' });
    const backdoor = created.groups.find((g) => g.name === 'Backdoor')!;

    const grant = await groups.setGroupPermissionRpc({
      ...CALLER,
      groupId: backdoor.id,
      permissionKey: ROLE_MANAGE,
      grant: true,
    });
    expect(grant.status).toBe('GROUP_STATUS_ESCALATION');

    // Step three still succeeds — joining a group is not the dangerous act — and the admin ends the
    // sequence with exactly what they started with.
    await groups.addGroupMemberRpc({ ...CALLER, groupId: backdoor.id, userId: 'admin-1' });
    const after = await resolver.resolve('acct-1', 'admin-1');
    expect(after.permissionKeys).not.toContain(ROLE_MANAGE);
  });

  it('an admin CAN confer a key they do hold — the rule bounds, it does not forbid', async () => {
    const { groups } = make(ADMIN_SEED);
    const r = await groups.setGroupPermissionRpc({
      ...CALLER,
      groupId: 'group-A',
      permissionKey: INBOX,
      grant: true,
    });
    expect(r.status).toBe('GROUP_STATUS_OK');
  });

  it('a super-admin can confer everything, because they hold everything', async () => {
    const { groups } = make({
      ...ADMIN_SEED,
      userRoles: [{ user_id: 'admin-1', roleKey: 'super_admin' }],
      rolePermissions: [
        { roleKey: 'super_admin', permKey: GROUP_MANAGE_KEY },
        { roleKey: 'super_admin', permKey: ROLE_MANAGE },
        { roleKey: 'super_admin', permKey: INBOX },
      ],
    });
    const r = await groups.setGroupPermissionRpc({
      callerAccountId: 'acct-1',
      callerUserId: 'admin-1',
      callerRoles: ['super_admin'],
      groupId: 'group-A',
      permissionKey: ROLE_MANAGE,
      grant: true,
    });
    expect(r.status).toBe('GROUP_STATUS_OK');
  });

  it('REVOKING is not gated by holding the key — taking access away cannot escalate', async () => {
    // And the alternative is worse: a group could end up holding a permission nobody present is able
    // to clean up.
    const { groups } = make({
      ...ADMIN_SEED,
      groupPermissions: [{ groupName: 'A', permKey: ROLE_MANAGE }],
    });
    const r = await groups.setGroupPermissionRpc({
      ...CALLER,
      groupId: 'group-A',
      permissionKey: ROLE_MANAGE,
      grant: false,
    });
    expect(r.status).toBe('GROUP_STATUS_OK');
  });

  it('a key inherited THROUGH ANOTHER GROUP counts as held — one resolver, one answer', async () => {
    // The caller's authority is whatever the single resolver says it is. If group-derived keys did
    // not count here, this handler would be deciding access on a different basis from every other
    // check in the product — which is the divergence ADR 0039 §2 forbids.
    const { groups } = make({
      ...ADMIN_SEED,
      groups: [{ name: 'A' }, { name: 'Elevated' }],
      groupMembers: [{ groupName: 'Elevated', user_id: 'admin-1' }],
      groupPermissions: [{ groupName: 'Elevated', permKey: ROLE_MANAGE }],
    });
    const r = await groups.setGroupPermissionRpc({
      ...CALLER,
      groupId: 'group-A',
      permissionKey: ROLE_MANAGE,
      grant: true,
    });
    expect(r.status).toBe('GROUP_STATUS_OK');
  });
});
