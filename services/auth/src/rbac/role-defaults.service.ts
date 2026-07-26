import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ROLE_DEFAULTS } from './catalogue';

type ScopedDb = ReturnType<PrismaService['forAccount']>;

export type RoleMutationOutcome =
  | { status: 'ok'; affectedUserIds: string[] }
  | { status: 'not_found' };

/**
 * RoleDefaultsService (feature 011, T024/T034 — US2/US3). Owns a role's DEFAULT (template)
 * permission set = its `RolePermission` rows. `list` serves the admin panel; `setRoleDefault` is the
 * whole-role edit (affects every INHERITED user immediately — standalone users are untouched, per the
 * resolver); `resetRoleToDefault` restores the system template from {@link ROLE_DEFAULTS} (0034).
 * Account-scoped (Principle I). Returns the affected user ids so the gateway can invalidate their
 * effective-permission cache (R-1).
 */
@Injectable()
export class RoleDefaultsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(accountId: string, roleKey: string): Promise<string[] | null> {
    const db = this.prisma.forAccount(accountId);
    const role = await db.role.findFirst({ where: { key: roleKey } });
    if (!role) return null;
    const rps = await db.rolePermission.findMany({ where: { role_id: role.id } });
    return this.keysFor(db, rps.map((rp) => rp.permission_id));
  }

  async setRoleDefault(
    accountId: string,
    roleKey: string,
    permissionKey: string,
    grant: boolean,
  ): Promise<RoleMutationOutcome> {
    const db = this.prisma.forAccount(accountId);
    const role = await db.role.findFirst({ where: { key: roleKey } });
    if (!role) return { status: 'not_found' };
    const perm = await db.permission.findFirst({ where: { key: permissionKey } });
    if (!perm) return { status: 'not_found' };

    if (grant) {
      await db.rolePermission.upsert({
        where: { role_id_permission_id: { role_id: role.id, permission_id: perm.id } },
        create: { role_id: role.id, permission_id: perm.id },
        update: {},
      });
    } else {
      await db.rolePermission.deleteMany({
        where: { role_id: role.id, permission_id: perm.id },
      });
    }
    return { status: 'ok', affectedUserIds: await this.usersOfRole(db, role.id) };
  }

  async resetRoleToDefault(accountId: string, roleKey: string): Promise<RoleMutationOutcome> {
    const db = this.prisma.forAccount(accountId);
    const role = await db.role.findFirst({ where: { key: roleKey } });
    if (!role) return { status: 'not_found' };
    const defaults = ROLE_DEFAULTS[roleKey];
    if (!defaults) return { status: 'not_found' };

    await db.rolePermission.deleteMany({ where: { role_id: role.id } });
    const ids = await this.idsFor(db, [...defaults]);
    for (const permission_id of ids) {
      await db.rolePermission.create({ data: { role_id: role.id, permission_id } });
    }
    return { status: 'ok', affectedUserIds: await this.usersOfRole(db, role.id) };
  }

  /** Users currently assigned this role — whose inherited effective set changes. */
  private async usersOfRole(db: ScopedDb, roleId: string): Promise<string[]> {
    const rows = await db.userRole.findMany({ where: { role_id: roleId } });
    return rows.map((r) => r.user_id);
  }

  private async keysFor(db: ScopedDb, ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const perms = await db.permission.findMany({ where: { id: { in: ids } } });
    return perms.map((p) => p.key);
  }

  private async idsFor(db: ScopedDb, keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const perms = await db.permission.findMany({ where: { key: { in: keys } } });
    return perms.map((p) => p.id);
  }
}
