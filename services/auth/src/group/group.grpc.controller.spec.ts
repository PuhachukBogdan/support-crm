import { GroupGrpcController, GROUP_MANAGE_KEY } from './group.grpc.controller';
import { GroupService } from './group.service';
import { RbacResolverService } from '../rbac/resolver.service';
import { AuditRepository } from '../audit/audit.repository';
import type { PrismaService } from '../prisma.service';
import { makeFakePrisma, type FakeSeed } from '../../tests/support/auth-test-doubles';

/**
 * The gRPC surface, and the second tier of the check (FR-014 / Principle II).
 *
 * ⚠️ **This handler resolves the caller's own permissions rather than trusting a role name**, which
 * is a deliberate departure from the neighbouring RBAC management handlers. Those re-check with
 * `isSuperAdmin(callerRoles)` because a role list is all the caller context their request carries.
 * Auth IS the resolver, so this controller can ask the real question — and gets two things for free:
 * a call that skips the gateway is refused on the same grounds rather than on a weaker proxy, and a
 * `platform.group.manage` granted THROUGH A GROUP works here too, because there is only one resolver
 * and it does not care where a key came from.
 */
const CALLER = {
  callerAccountId: 'acct-1',
  callerUserId: 'admin-1',
  callerRoles: ['admin'],
};

/** A caller whose role template includes the group key. */
const SEED_ALLOWED: FakeSeed = {
  users: [{ id: 'admin-1' }, { id: 'u-1' }],
  userRoles: [{ user_id: 'admin-1', roleKey: 'admin' }],
  permissions: [{ key: GROUP_MANAGE_KEY, category: 'platform' }, { key: 'crm.inbox.view' }],
  // The caller holds the inbox key too, so the grant cases below exercise the HANDLER rather than the
  // no-escalation rule — a caller may confer only what they already hold, which has its own spec
  // (`group-grant-parity.spec.ts`).
  rolePermissions: [
    { roleKey: 'admin', permKey: GROUP_MANAGE_KEY },
    { roleKey: 'admin', permKey: 'crm.inbox.view' },
  ],
  groups: [{ name: 'A' }],
};

/** The same caller, with the key withheld — everything else identical. */
const SEED_DENIED: FakeSeed = { ...SEED_ALLOWED, rolePermissions: [] };

function make(seed: FakeSeed) {
  const prisma = makeFakePrisma(seed) as unknown as PrismaService;
  const controller = new GroupGrpcController(
    new GroupService(prisma, new AuditRepository(prisma)),
    new RbacResolverService(prisma),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = (prisma as any)._tables;
  return { controller, tables };
}

describe('GroupGrpcController — the permission gate', () => {
  it('permits a caller holding platform.group.manage', async () => {
    const { controller } = make(SEED_ALLOWED);
    const r = await controller.createGroupRpc({ ...CALLER, name: 'Payments' });
    expect(r.status).toBe('GROUP_STATUS_OK');
    expect(r.groupId).not.toBe('');
  });

  it.each([
    ['create', (c: GroupGrpcController) => c.createGroupRpc({ ...CALLER, name: 'x' })],
    ['rename', (c: GroupGrpcController) => c.renameGroupRpc({ ...CALLER, groupId: 'group-A', name: 'x' })],
    ['delete', (c: GroupGrpcController) => c.deleteGroupRpc({ ...CALLER, groupId: 'group-A' })],
    ['addMember', (c: GroupGrpcController) => c.addGroupMemberRpc({ ...CALLER, groupId: 'group-A', userId: 'u-1' })],
    ['removeMember', (c: GroupGrpcController) => c.removeGroupMemberRpc({ ...CALLER, groupId: 'group-A', userId: 'u-1' })],
    [
      'setPermission',
      (c: GroupGrpcController) =>
        c.setGroupPermissionRpc({ ...CALLER, groupId: 'group-A', permissionKey: 'crm.inbox.view', grant: true }),
    ],
  ])('refuses %s without the key', async (_name, call) => {
    const { controller, tables } = make(SEED_DENIED);
    expect((await call(controller)).status).toBe('GROUP_STATUS_FORBIDDEN');
    // A refusal must also be inert: nothing written, nothing audited.
    expect(tables.auditEntries).toHaveLength(0);
    expect(tables.groups).toHaveLength(1);
  });

  it('refuses a caller with no identity at all (a call that skipped the gateway)', async () => {
    const { controller } = make(SEED_ALLOWED);
    const r = await controller.createGroupRpc({
      callerAccountId: '',
      callerUserId: '',
      callerRoles: [],
      name: 'x',
    });
    expect(r.status).toBe('GROUP_STATUS_FORBIDDEN');
  });

  it('refuses a mutation attempted while previewing another role', async () => {
    // View-as is READ-ONLY. A preview that could edit groups would be a preview that grants access —
    // the exact opposite of what it exists for. `readOnly` is what enforces it, not the key.
    const { controller, tables } = make(SEED_ALLOWED);
    const spy = jest
      .spyOn(RbacResolverService.prototype, 'resolve')
      .mockResolvedValue({
        roleKey: 'admin',
        permissionKeys: [GROUP_MANAGE_KEY],
        mode: 'inherited',
        isPreview: true,
        readOnly: true,
        groupPermissionKeys: [],
        basePermissionKeys: [GROUP_MANAGE_KEY],
      });
    expect((await controller.createGroupRpc({ ...CALLER, name: 'x' })).status).toBe(
      'GROUP_STATUS_FORBIDDEN',
    );
    expect(tables.groups).toHaveLength(1);
    spy.mockRestore();
  });

  it('honours the key when it arrives THROUGH A GROUP, not from the role', async () => {
    // The point of the whole feature, asserted at the enforcement point: the resolver returns one set
    // and this controller cannot tell where a key came from.
    const { controller } = make({
      ...SEED_DENIED,
      groups: [{ name: 'A' }, { name: 'Admins' }],
      groupMembers: [{ groupName: 'Admins', user_id: 'admin-1' }],
      groupPermissions: [{ groupName: 'Admins', permKey: GROUP_MANAGE_KEY }],
    });
    expect((await controller.createGroupRpc({ ...CALLER, name: 'Payments' })).status).toBe(
      'GROUP_STATUS_OK',
    );
  });
});

describe('GroupGrpcController — wire mapping', () => {
  it('maps each refusal to its own status rather than to one generic failure', async () => {
    const { controller } = make(SEED_ALLOWED);
    expect((await controller.createGroupRpc({ ...CALLER, name: '  ' })).status).toBe(
      'GROUP_STATUS_INVALID_NAME',
    );
    expect((await controller.createGroupRpc({ ...CALLER, name: 'A' })).status).toBe(
      'GROUP_STATUS_NAME_TAKEN',
    );
    expect(
      (await controller.renameGroupRpc({ ...CALLER, groupId: 'nope', name: 'x' })).status,
    ).toBe('GROUP_STATUS_NOT_FOUND');
    expect(
      (
        await controller.setGroupPermissionRpc({
          ...CALLER,
          groupId: 'group-A',
          permissionKey: 'not.a.key',
          grant: true,
        })
      ).status,
    ).toBe('GROUP_STATUS_UNKNOWN_PERMISSION');
  });

  it('returns affectedUserIds so the gateway can invalidate the right caches', async () => {
    const { controller } = make({
      ...SEED_ALLOWED,
      groupMembers: [{ groupName: 'A', user_id: 'u-1' }],
    });
    const r = await controller.setGroupPermissionRpc({
      ...CALLER,
      groupId: 'group-A',
      permissionKey: 'crm.inbox.view',
      grant: true,
    });
    expect(r.affectedUserIds).toEqual(['u-1']);
  });

  it('lists members, and answers an unknown group with an empty list — not an error', async () => {
    // Auto-assignment consumes this reply and must treat "no members" and "no such group" the same
    // way. What it must never confuse either with is a FAILED call, and that distinction lives in the
    // client (which raises), not here.
    const { controller } = make({
      ...SEED_ALLOWED,
      groupMembers: [{ groupName: 'A', user_id: 'u-1' }],
    });
    // Feature 031: the desk's routability travels with its membership — one answer, one moment. A desk
    // nobody has marked is NOT routable, which is the column's default and the safe direction.
    expect(await controller.listGroupMembersRpc({ accountId: 'acct-1', groupId: 'group-A' })).toEqual({
      userIds: ['u-1'],
      routable: false,
    });
    // ⚠️ An unknown desk answers an empty list rather than an error, and is certainly not routable —
    // otherwise a typo'd group id would look like a queue with nobody on it.
    expect(await controller.listGroupMembersRpc({ accountId: 'acct-1', groupId: 'nope' })).toEqual({
      userIds: [],
      routable: false,
    });
  });
});
