import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/** A user's resolved effective permissions (Auth is the source of truth — R-1). */
export interface ResolvedPermissions {
  roleKey: string;
  permissionKeys: string[];
  mode: 'inherited' | 'standalone';
  isPreview: boolean;
  readOnly: boolean;
}

/**
 * RbacResolverService (feature 011, T015). Resolves a user's EFFECTIVE permission set — the hot
 * path the gateway calls on a cache miss (R-1). Copy-on-write model (R-2):
 *  - no personalization (mode inherited / absent) → the user's role's DEFAULT set (live);
 *  - standalone → the user's materialized snapshot rows;
 *  - no role → empty (deny-by-default, FR-012).
 *
 * Reads run through the account-scoped client (`forAccount`) so a cross-account user/permission is
 * structurally unreachable (Principle I). `preview_role` (view-as) shaping is wired in US5 — here it
 * is threaded through and, when present, marks the result read-only without yet re-shaping the set.
 */
@Injectable()
export class RbacResolverService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async resolve(
    accountId: string,
    userId: string,
    previewRole?: string,
  ): Promise<ResolvedPermissions> {
    const db = this.prisma.forAccount(accountId);
    const isPreview = !!previewRole;

    // View-as preview (US5, R-5): resolve the PREVIEWED role's DEFAULT permission set and mark the
    // result READ-ONLY. This shapes reads exactly as that role would see them, WITHOUT touching the
    // caller's own permissions or granting any write capability (FR-020/021 / SC-009). Account-scoped.
    if (previewRole) {
      const role = await db.role.findFirst({ where: { key: previewRole } });
      const permissionKeys = role
        ? await this.keysFor(
            db,
            (await db.rolePermission.findMany({ where: { role_id: role.id } })).map(
              (rp) => rp.permission_id,
            ),
          )
        : [];
      return { roleKey: previewRole, permissionKeys, mode: 'inherited', isPreview: true, readOnly: true };
    }

    // Standalone snapshot takes precedence over live inheritance (R-2).
    const set = await db.userPermissionSet.findUnique({ where: { user_id: userId } });
    if (set?.mode === 'standalone') {
      const entries = await db.userPermissionEntry.findMany({
        where: { user_id: userId, granted: true },
      });
      const permissionKeys = await this.keysFor(db, entries.map((e) => e.permission_id));
      return { roleKey: '', permissionKeys, mode: 'standalone', isPreview, readOnly: isPreview };
    }

    // Inherited: resolve the user's role → its default (template) permission set.
    const userRoles = await db.userRole.findMany({
      where: { user_id: userId },
      include: { role: true },
    });
    const role = userRoles[0]?.role;
    if (!role) {
      return { roleKey: '', permissionKeys: [], mode: 'inherited', isPreview, readOnly: isPreview };
    }
    const rolePerms = await db.rolePermission.findMany({ where: { role_id: role.id } });
    const permissionKeys = await this.keysFor(db, rolePerms.map((rp) => rp.permission_id));
    return { roleKey: role.key, permissionKeys, mode: 'inherited', isPreview, readOnly: isPreview };
  }

  /** Map permission ids → their keys (account-scoped by the extension). */
  private async keysFor(
    db: ReturnType<PrismaService['forAccount']>,
    ids: string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const perms = await db.permission.findMany({ where: { id: { in: ids } } });
    return perms.map((p) => p.key);
  }
}
