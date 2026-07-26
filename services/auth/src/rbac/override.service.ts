import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { PrivilegeAuditService } from './privilege-audit.service';
import { RoleDefaultsService } from './role-defaults.service';

type ScopedDb = ReturnType<PrismaService['forAccount']>;

export type OverrideOutcome =
  | { status: 'ok'; affectedUserIds: string[] }
  | { status: 'cross_role' }
  | { status: 'not_found' };

export interface ResetTarget {
  scope: 'user' | 'group' | 'role';
  userId?: string;
  userIds?: string[];
  roleKey?: string;
}

/**
 * OverrideService (feature 011, T033 — US3). Copy-on-write personalization (R-2): the first per-user
 * edit SNAPSHOTS the role's current defaults into `UserPermissionEntry` and flips the user to
 * `standalone`; from then the user is an independent set (later role-template edits do not propagate).
 * Reset discards the snapshot → the user re-inherits the live role default. Group edits are constrained
 * to a SINGLE role (FR-011). Every mutation is audited (FR-013). Account-scoped (Principle I).
 */
@Injectable()
export class OverrideService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PrivilegeAuditService) private readonly audit: PrivilegeAuditService,
    @Inject(RoleDefaultsService) private readonly roleDefaults: RoleDefaultsService,
  ) {}

  async personalizeUser(
    accountId: string,
    actorUserId: string,
    userId: string,
    permissionKey: string,
    grant: boolean,
  ): Promise<OverrideOutcome> {
    const db = this.prisma.forAccount(accountId);
    const perm = await db.permission.findFirst({ where: { key: permissionKey } });
    if (!perm) return { status: 'not_found' };
    const role = await this.roleOf(db, userId);
    if (!role) return { status: 'not_found' };

    await this.ensureStandalone(db, accountId, userId, role.id);
    if (grant) {
      await db.userPermissionEntry.upsert({
        where: { user_id_permission_id: { user_id: userId, permission_id: perm.id } },
        create: { user_id: userId, permission_id: perm.id, granted: true },
        update: { granted: true },
      });
    } else {
      await db.userPermissionEntry.deleteMany({
        where: { user_id: userId, permission_id: perm.id },
      });
    }
    await this.audit.record(accountId, actorUserId, grant ? 'perm_grant' : 'perm_revoke', userId, {
      scope: 'user',
      permissionKey,
      grant,
    });
    return { status: 'ok', affectedUserIds: [userId] };
  }

  async personalizeGroup(
    accountId: string,
    actorUserId: string,
    userIds: string[],
    permissionKey: string,
    grant: boolean,
  ): Promise<OverrideOutcome> {
    const db = this.prisma.forAccount(accountId);
    // Single-role constraint (FR-011): every selected user must share one role.
    const roleKeys = new Set<string>();
    for (const uid of userIds) {
      const role = await this.roleOf(db, uid);
      if (!role) return { status: 'not_found' };
      roleKeys.add(role.key);
    }
    if (roleKeys.size > 1) return { status: 'cross_role' };

    const perm = await db.permission.findFirst({ where: { key: permissionKey } });
    if (!perm) return { status: 'not_found' };

    for (const uid of userIds) {
      const role = await this.roleOf(db, uid);
      if (!role) return { status: 'not_found' };
      await this.ensureStandalone(db, accountId, uid, role.id);
      if (grant) {
        await db.userPermissionEntry.upsert({
          where: { user_id_permission_id: { user_id: uid, permission_id: perm.id } },
          create: { user_id: uid, permission_id: perm.id, granted: true },
          update: { granted: true },
        });
      } else {
        await db.userPermissionEntry.deleteMany({
          where: { user_id: uid, permission_id: perm.id },
        });
      }
    }
    await this.audit.record(accountId, actorUserId, grant ? 'perm_grant' : 'perm_revoke', userIds.join(','), {
      scope: 'group',
      permissionKey,
      grant,
    });
    return { status: 'ok', affectedUserIds: userIds };
  }

  async resetToDefault(
    accountId: string,
    actorUserId: string,
    target: ResetTarget,
  ): Promise<OverrideOutcome> {
    const db = this.prisma.forAccount(accountId);

    if (target.scope === 'role') {
      const roleKey = target.roleKey ?? '';
      const res = await this.roleDefaults.resetRoleToDefault(accountId, roleKey);
      if (res.status === 'not_found') return { status: 'not_found' };
      await this.audit.record(accountId, actorUserId, 'reset', roleKey, { scope: 'role', roleKey });
      return { status: 'ok', affectedUserIds: res.affectedUserIds };
    }

    const userIds = target.scope === 'user' ? [target.userId ?? ''] : target.userIds ?? [];
    for (const uid of userIds) {
      await db.userPermissionEntry.deleteMany({ where: { user_id: uid } });
      await db.userPermissionSet.upsert({
        where: { user_id: uid },
        create: { user_id: uid, account_id: accountId, mode: 'inherited', snapshot_role_id: null },
        update: { mode: 'inherited', snapshot_role_id: null },
      });
    }
    await this.audit.record(accountId, actorUserId, 'reset', userIds.join(','), {
      scope: target.scope,
    });
    return { status: 'ok', affectedUserIds: userIds };
  }

  /** Snapshot the role's current defaults onto the user + flip to standalone, once (R-2). */
  private async ensureStandalone(
    db: ScopedDb,
    accountId: string,
    userId: string,
    roleId: string,
  ): Promise<void> {
    const set = await db.userPermissionSet.findUnique({ where: { user_id: userId } });
    if (set?.mode === 'standalone') return;
    const rolePerms = await db.rolePermission.findMany({ where: { role_id: roleId } });
    for (const rp of rolePerms) {
      await db.userPermissionEntry.upsert({
        where: { user_id_permission_id: { user_id: userId, permission_id: rp.permission_id } },
        create: { user_id: userId, permission_id: rp.permission_id, granted: true },
        update: {},
      });
    }
    await db.userPermissionSet.upsert({
      where: { user_id: userId },
      create: { user_id: userId, account_id: accountId, mode: 'standalone', snapshot_role_id: roleId },
      update: { mode: 'standalone', snapshot_role_id: roleId },
    });
  }

  private async roleOf(db: ScopedDb, userId: string): Promise<{ id: string; key: string } | null> {
    const rows = await db.userRole.findMany({ where: { user_id: userId }, include: { role: true } });
    const role = rows[0]?.role;
    return role ? { id: role.id, key: role.key } : null;
  }
}
