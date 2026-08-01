import { GroupService } from '../src/group/group.service';
import { RbacResolverService } from '../src/rbac/resolver.service';
import { AuditRepository } from '../src/audit/audit.repository';
import type { PrismaService } from '../src/prisma.service';

/**
 * Cross-account isolation for the group layer (feature 024 / Principle I / SEC-17).
 *
 * The trap is built in deliberately: **the two accounts hold groups with the SAME ids and the SAME
 * names, and users with the same ids.** A handler that filtered after reading, or that trusted an id
 * supplied by the caller, would pass a naive test and fail this one.
 *
 * The fake `forAccount(acc)` reproduces what the feature-007 Prisma extension does — it confines
 * every operation to `acc`. So "not found" below is the *structural* consequence of scoping, not a
 * check the service remembered to perform.
 *
 * Why this matters more for groups than for most tables: a group is an **authorization input**
 * (ADR 0039 §1). A group leaking across the tenancy wall would not merely show the wrong data, it
 * would confer the wrong permissions.
 */
const ACTOR = { userId: 'admin-1' };

interface Row {
  [k: string]: unknown;
}

function makeStore() {
  // Same ids and same names in both accounts — the collision a guessing caller would try.
  const groups: Row[] = [
    { id: 'shared-group', account_id: 'acc-1', name: 'Support', active: true },
    { id: 'shared-group', account_id: 'acc-2', name: 'Support', active: true },
    { id: 'only-acc2', account_id: 'acc-2', name: 'Payments', active: true },
  ];
  const users: Row[] = [
    { id: 'shared-user', account_id: 'acc-1' },
    { id: 'shared-user', account_id: 'acc-2' },
    { id: 'only-acc2-user', account_id: 'acc-2' },
    { id: 'admin-1', account_id: 'acc-1' },
  ];
  const permissions: Row[] = [
    { id: 'perm-1', account_id: 'acc-1', key: 'crm.inbox.view' },
    { id: 'perm-2', account_id: 'acc-2', key: 'crm.contact.read_pii' },
  ];
  // Membership and grants carry no account_id — they are scoped through their parents, which is
  // exactly the property under test here.
  const groupMembers: Row[] = [{ group_id: 'only-acc2', user_id: 'only-acc2-user' }];
  const groupPermissions: Row[] = [{ group_id: 'only-acc2', permission_id: 'perm-2' }];
  const auditEntries: Row[] = [];

  const scopedTo = (acc: string) => {
    const inAcc = <T extends Row>(rows: T[]) => rows.filter((r) => r.account_id === acc);
    /** Ids visible in this account — the seam the join tables inherit. */
    const groupIds = () => inAcc(groups).map((g) => g.id as string);

    const db = {
      group: {
        findFirst: async ({ where }: { where: { id?: string; name?: string } }) =>
          inAcc(groups).find((g) =>
            where.id !== undefined ? g.id === where.id : g.name === where.name,
          ) ?? null,
        findMany: async () => inAcc(groups),
        create: async ({ data }: { data: { account_id: string; name: string } }) => {
          const row = { id: `new-${groups.length}`, ...data, active: true };
          groups.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          const g = inAcc(groups).find((x) => x.id === where.id)!;
          Object.assign(g, data);
          return g;
        },
        delete: async ({ where }: { where: { id: string } }) => {
          const i = groups.findIndex((g) => g.id === where.id && g.account_id === acc);
          return groups.splice(i, 1)[0];
        },
      },
      groupMember: {
        findMany: async ({ where }: { where?: { group_id?: string | { in: string[] }; user_id?: string } } = {}) =>
          groupMembers.filter((m) => {
            if (!groupIds().includes(m.group_id as string)) return false;
            const g = where?.group_id;
            if (typeof g === 'string' && m.group_id !== g) return false;
            if (g && typeof g === 'object' && !g.in.includes(m.group_id as string)) return false;
            if (where?.user_id !== undefined && m.user_id !== where.user_id) return false;
            return true;
          }),
        upsert: async ({ create }: { create: { group_id: string; user_id: string } }) => {
          groupMembers.push({ ...create });
          return create;
        },
        deleteMany: async () => ({ count: 0 }),
      },
      groupPermission: {
        findMany: async ({ where }: { where?: { group_id?: string | { in: string[] } } } = {}) =>
          groupPermissions.filter((p) => {
            if (!groupIds().includes(p.group_id as string)) return false;
            const g = where?.group_id;
            if (typeof g === 'string' && p.group_id !== g) return false;
            if (g && typeof g === 'object' && !g.in.includes(p.group_id as string)) return false;
            return true;
          }),
        upsert: async ({ create }: { create: Row }) => {
          groupPermissions.push({ ...create });
          return create;
        },
        deleteMany: async () => ({ count: 0 }),
      },
      user: {
        findFirst: async ({ where }: { where: { id: string } }) =>
          inAcc(users).find((u) => u.id === where.id) ?? null,
      },
      permission: {
        findFirst: async ({ where }: { where: { key: string } }) =>
          inAcc(permissions).find((p) => p.key === where.key) ?? null,
        findMany: async ({ where }: { where?: { id?: { in: string[] } } } = {}) =>
          inAcc(permissions).filter((p) => !where?.id || where.id.in.includes(p.id as string)),
      },
      userPermissionSet: { findUnique: async () => null },
      userPermissionEntry: { findMany: async () => [] },
      userRole: { findMany: async () => [] },
      rolePermission: { findMany: async () => [] },
      auditEntry: {
        create: async ({ data }: { data: Row }) => {
          auditEntries.push(data);
          return data;
        },
      },
      $transaction: async (s: unknown) => (Array.isArray(s) ? Promise.all(s) : s),
    };
    return db;
  };

  const prisma = { forAccount: scopedTo } as unknown as PrismaService;
  return { prisma, tables: { groups, groupMembers, groupPermissions, auditEntries } };
}

describe('feature 024 — a group never crosses an account (Principle I)', () => {
  it('sees only its own account’s groups, even where ids and names collide', async () => {
    const { prisma } = makeStore();
    const groups = new GroupService(prisma, new AuditRepository(prisma));
    const listed = await groups.list('acc-1');
    expect(listed.map((g) => g.id)).toEqual(['shared-group']);
    expect(listed).toHaveLength(1); // 'only-acc2' is invisible, not merely filtered out afterwards
  });

  it('cannot rename, delete or read a group that belongs to the other account', async () => {
    const { prisma, tables } = makeStore();
    const groups = new GroupService(prisma, new AuditRepository(prisma));
    expect((await groups.rename('acc-1', ACTOR, 'only-acc2', 'stolen')).status).toBe('not_found');
    expect((await groups.remove('acc-1', ACTOR, 'only-acc2')).status).toBe('not_found');
    expect(await groups.listMembers('acc-1', 'only-acc2')).toBeNull();
    // Nothing was touched, and no audit entry was fabricated for a group we cannot see.
    expect(tables.groups).toHaveLength(3);
    expect(tables.auditEntries).toHaveLength(0);
  });

  it('a rename in one account leaves the same-id group in the other untouched', async () => {
    const { prisma, tables } = makeStore();
    const groups = new GroupService(prisma, new AuditRepository(prisma));
    await groups.rename('acc-1', ACTOR, 'shared-group', 'Renamed');
    const both = tables.groups.filter((g) => g.id === 'shared-group');
    expect(both.find((g) => g.account_id === 'acc-1')!.name).toBe('Renamed');
    expect(both.find((g) => g.account_id === 'acc-2')!.name).toBe('Support');
  });

  it('cannot add a user from the other account, even one whose id exists in both', async () => {
    const { prisma, tables } = makeStore();
    const groups = new GroupService(prisma, new AuditRepository(prisma));
    expect(
      (await groups.addMember('acc-1', ACTOR, 'shared-group', 'only-acc2-user')).status,
    ).toBe('not_found');
    // The colliding id resolves to THIS account's user — the membership is local, not cross-tenant.
    expect((await groups.addMember('acc-1', ACTOR, 'shared-group', 'shared-user')).status).toBe(
      'ok',
    );
    expect(tables.groupMembers.filter((m) => m.group_id === 'shared-group')).toHaveLength(1);
  });

  it('cannot grant a permission that belongs to the other account', async () => {
    const { prisma } = makeStore();
    const groups = new GroupService(prisma, new AuditRepository(prisma));
    // `crm.contact.read_pii` exists — in acc-2. From acc-1 it is simply not a key that exists.
    expect(
      (
        await groups.setPermission(
          'acc-1',
          ACTOR,
          ['crm.contact.read_pii'],
          'shared-group',
          'crm.contact.read_pii',
          true,
        )
      ).status,
    ).toBe('unknown_permission');
  });

  it('the RESOLVER never picks up another account’s group grants', async () => {
    // The sharpest case: a group is an authorization input, so a leak here confers permissions rather
    // than merely showing data.
    const { prisma } = makeStore();
    const r = await new RbacResolverService(prisma).resolve('acc-1', 'only-acc2-user');
    expect(r.permissionKeys).toEqual([]);
  });
});
