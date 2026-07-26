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

  /**
   * Plan a role reset: do the reads, return the WRITES for the caller to execute.
   *
   * Split out by feature 015 (roadmap 4.8) so the reset's audit entry can share the caller's transaction.
   * Without this the role-scope reset could not be strict — its writes lived here and the audit entry
   * lived in OverrideService, in two transactions, so a failing audit would leave a silently unrecorded
   * reset of an entire role's permissions.
   */
  async planResetRole(
    accountId: string,
    roleKey: string,
  ): Promise<
    | { status: 'not_found' }
    | { status: 'ok'; affectedUserIds: string[]; statements: unknown[] }
  > {
    const db = this.prisma.forAccount(accountId);
    const role = await db.role.findFirst({ where: { key: roleKey } });
    if (!role) return { status: 'not_found' };
    const defaults = ROLE_DEFAULTS[roleKey];
    if (!defaults) return { status: 'not_found' };

    // Both reads happen BEFORE any write is executed — the ids do not depend on the delete.
    const ids = await this.idsFor(db, [...defaults]);
    const affectedUserIds = await this.usersOfRole(db, role.id);

    return {
      status: 'ok',
      affectedUserIds,
      statements: [
        db.rolePermission.deleteMany({ where: { role_id: role.id } }),
        ...ids.map((permission_id) =>
          db.rolePermission.create({ data: { role_id: role.id, permission_id } }),
        ),
      ],
    };
  }

  /**
   * Reset a role on its own (no audit entry). Kept for callers that are not composing a transaction; the
   * audited path goes through {@link planResetRole} so action and entry commit together.
   */
  async resetRoleToDefault(accountId: string, roleKey: string): Promise<RoleMutationOutcome> {
    const plan = await this.planResetRole(accountId, roleKey);
    if (plan.status === 'not_found') return { status: 'not_found' };
    await this.prisma.forAccount(accountId).$transaction(plan.statements as never);
    return { status: 'ok', affectedUserIds: plan.affectedUserIds };
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
