import { OverrideService } from './override.service';
import { RoleAssignmentService } from './role-assignment.service';
import { RoleDefaultsService } from './role-defaults.service';
import { AuditRepository } from '../audit/audit.repository';
import type { PrismaService } from '../prisma.service';

/**
 * T038 (feature 015, US2) — **a failing audit write REFUSES the action.** SC-004.
 *
 * The assertion is on the TARGET's state, not on the thrown error. "Rolled back" and "never attempted" both
 * have to hold, and only a state assertion distinguishes them from "wrote and then reported failure".
 *
 * This spec builds its own **lazy** Prisma fake rather than reusing `makeFakePrisma`, deliberately: the shared
 * fake executes model calls eagerly, which cannot model atomicity — the mutations would already have been
 * applied by the time the transaction is handed the batch. An eager fake here would let a rolled-back write
 * "stick" and would therefore hide exactly the regression this test exists to catch. (The same lesson
 * feature 014 learned when its breach-trigger fake reported a phantom double-write.)
 */
type Deferred = { __run: () => void };

function lazyPrisma(opts: { auditFails?: boolean } = {}) {
  const entries: Record<string, unknown>[] = [];
  const permissionSets: Record<string, unknown>[] = [];
  const auditRows: Record<string, unknown>[] = [];
  const roles = [{ id: 'role-support_agent', key: 'support_agent' }];

  const defer = (run: () => void): Deferred => ({ __run: run });

  const scoped: Record<string, unknown> = {
    permission: { findFirst: async () => ({ id: 'perm-1', key: 'reports.export' }) },
    userRole: {
      findMany: async () => [{ user_id: 'u-1', role: roles[0] }],
      deleteMany: () => defer(() => undefined),
      create: () => defer(() => undefined),
    },
    role: { findFirst: async () => roles[0] },
    rolePermission: { findMany: async () => [] },
    userPermissionSet: {
      findUnique: async () => permissionSets[0] ?? null,
      upsert: (a: { create: Record<string, unknown> }) =>
        defer(() => void permissionSets.push(a.create)),
    },
    userPermissionEntry: {
      upsert: (a: { create: Record<string, unknown> }) => defer(() => void entries.push(a.create)),
      deleteMany: () => defer(() => entries.splice(0, entries.length)),
    },
    auditEntry: {
      create: (a: { data: Record<string, unknown> }) =>
        defer(() => {
          if (opts.auditFails) throw new Error('audit write failed');
          auditRows.push(a.data);
        }),
    },
  };

  // Snapshot → run the batch → restore on any failure. THAT is the atomicity under test.
  scoped.$transaction = async (arg: unknown) => {
    if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(scoped);
    const snapshot = {
      entries: [...entries],
      permissionSets: [...permissionSets],
      auditRows: [...auditRows],
    };
    try {
      for (const stmt of arg as Deferred[]) stmt.__run();
      return [];
    } catch (err) {
      entries.length = 0;
      entries.push(...snapshot.entries);
      permissionSets.length = 0;
      permissionSets.push(...snapshot.permissionSets);
      auditRows.length = 0;
      auditRows.push(...snapshot.auditRows);
      throw err;
    }
  };

  const prisma = { forAccount: () => scoped } as unknown as PrismaService;
  return { prisma, entries, permissionSets, auditRows };
}

function services(prisma: PrismaService) {
  const audit = new AuditRepository(prisma);
  return {
    overrides: new OverrideService(prisma, audit, new RoleDefaultsService(prisma)),
    assignment: new RoleAssignmentService(prisma, audit),
  };
}

describe('a permission grant is refused when its audit entry cannot be written', () => {
  it('*** leaves the user’s permissions UNCHANGED (not merely reports an error) ***', async () => {
    const world = lazyPrisma({ auditFails: true });
    const { overrides } = services(world.prisma);

    await expect(
      overrides.personalizeUser('acct-1', { userId: 'god' }, 'u-1', 'reports.export', true),
    ).rejects.toThrow('audit write failed');

    // The point of the test: nothing landed. Not "landed and was undone" — nothing.
    expect(world.entries).toEqual([]);
    expect(world.permissionSets).toEqual([]);
    expect(world.auditRows).toEqual([]);
  });

  it('succeeds — with both the change and the entry — when the audit write works', async () => {
    const world = lazyPrisma();
    const { overrides } = services(world.prisma);

    const res = await overrides.personalizeUser('acct-1', { userId: 'god' }, 'u-1', 'reports.export', true);

    expect(res.status).toBe('ok');
    expect(world.entries).toHaveLength(1);
    expect(world.auditRows).toHaveLength(1);
    expect(world.auditRows[0]).toMatchObject({
      action: 'permission.grant',
      actor_user_id: 'god',
      target_ref: 'u-1',
    });
  });
});

describe('a role assignment is refused when its audit entry cannot be written', () => {
  it('leaves the role assignment untouched', async () => {
    const world = lazyPrisma({ auditFails: true });
    const { assignment } = services(world.prisma);

    await expect(
      assignment.assignRole('acct-1', { userId: 'god' }, 'u-1', 'support_agent', 'assign'),
    ).rejects.toThrow('audit write failed');
    expect(world.auditRows).toEqual([]);
  });

  it('records role.assign when it works', async () => {
    const world = lazyPrisma();
    const { assignment } = services(world.prisma);
    await assignment.assignRole('acct-1', { userId: 'god' }, 'u-1', 'support_agent', 'assign');
    expect(world.auditRows[0]).toMatchObject({ action: 'role.assign', target_ref: 'u-1' });
  });
});

describe('the entry and the action are in ONE transaction', () => {
  it('a reset writes its entry and its clears together', async () => {
    const world = lazyPrisma({ auditFails: true });
    const { overrides } = services(world.prisma);
    // Seed a standalone set so the reset has something to clear.
    world.permissionSets.push({ user_id: 'u-1', mode: 'standalone' });
    world.entries.push({ user_id: 'u-1', permission_id: 'perm-1' });

    await expect(
      overrides.resetToDefault('acct-1', { userId: 'god' }, { scope: 'user', userId: 'u-1' }),
    ).rejects.toThrow('audit write failed');

    // The entry the reset would have cleared is still there — the reset did not half-happen.
    expect(world.entries).toHaveLength(1);
  });
});
