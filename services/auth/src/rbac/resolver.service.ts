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
 *
 * ── Feature 024 (roadmap 5.3, ADR 0039): the THIRD term ─────────────────────────────────────────
 *
 * effective = ( standalone snapshot OR role defaults ) ∪ ⋃ grants of every group the user belongs to
 *
 * **This is the only place the union happens, and that is the requirement, not a tidiness
 * preference.** A group contributes into the one policy layer and never gets a check of its own
 * (ADR 0039 §2): two mechanisms that both decide access will diverge, the only question is when, and
 * the divergence is invisible until someone sees something they should not.
 *
 * Three consequences worth stating, because each is a decision:
 *
 *  1. **Both real exits get the term, including `standalone`.** Personalising someone's permissions
 *     is copy-on-write over THEIR OWN set; it says nothing about which unit they work in. A person
 *     handed a snapshot has not left their group, and inferring that silently would be a permission
 *     change nobody made.
 *  2. **The snapshot is frozen and the group term is LIVE, deliberately.** A membership is an ongoing
 *     fact, not something you were given once. So a standalone user's effective set is half frozen
 *     and half live — which looks like an inconsistency and is the correct semantics. Do not "fix" it
 *     by snapshotting the group term: that recreates the frozen-privilege problem feature 014
 *     rejected, where revoking a permission failed to stop the thing it authorised.
 *  3. **The preview exit does NOT get the term.** View-as answers "what can this ROLE do?". Folding in
 *     the previewing administrator's own memberships would make the preview report more access than
 *     the previewed role has — the one question it exists to answer correctly.
 *
 * A group GRANTS and never DENIES: this is a set union, and `GroupPermission` has no column that
 * could express anything else.
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

    // Feature 024: resolved ONCE, before the branch, so no exit below can silently skip it. Every
    // real path unions it in; the preview path above has already returned.
    const groupKeys = await this.groupKeys(db, userId);

    // Standalone snapshot takes precedence over live inheritance (R-2).
    const set = await db.userPermissionSet.findUnique({ where: { user_id: userId } });
    if (set?.mode === 'standalone') {
      const entries = await db.userPermissionEntry.findMany({
        where: { user_id: userId, granted: true },
      });
      const own = await this.keysFor(db, entries.map((e) => e.permission_id));
      return {
        roleKey: '',
        permissionKeys: union(own, groupKeys),
        mode: 'standalone',
        isPreview,
        readOnly: isPreview,
      };
    }

    // Inherited: resolve the user's role → its default (template) permission set.
    const userRoles = await db.userRole.findMany({
      where: { user_id: userId },
      include: { role: true },
    });
    const role = userRoles[0]?.role;
    if (!role) {
      // Deny-by-default still holds (FR-012): with no role and no group this is the empty set. But a
      // person with no role who IS in a group holds exactly what the group grants — the union of
      // nothing and something is something, and pretending otherwise would be a second rule.
      return {
        roleKey: '',
        permissionKeys: groupKeys,
        mode: 'inherited',
        isPreview,
        readOnly: isPreview,
      };
    }
    const rolePerms = await db.rolePermission.findMany({ where: { role_id: role.id } });
    const own = await this.keysFor(db, rolePerms.map((rp) => rp.permission_id));
    return {
      roleKey: role.key,
      permissionKeys: union(own, groupKeys),
      mode: 'inherited',
      isPreview,
      readOnly: isPreview,
    };
  }

  /**
   * Every permission key conferred by every group this user belongs to (feature 024).
   *
   * Two indexed reads on a path that already performs several, behind the gateway's 30-second cache:
   * `GroupMember` by `user_id` (its dedicated index), then the grants, then the existing id→key
   * helper. A user in no group costs one lookup that returns nothing.
   */
  private async groupKeys(
    db: ReturnType<PrismaService['forAccount']>,
    userId: string,
  ): Promise<string[]> {
    const memberships = await db.groupMember.findMany({ where: { user_id: userId } });
    if (memberships.length === 0) return [];
    const grants = await db.groupPermission.findMany({
      where: { group_id: { in: memberships.map((m) => m.group_id) } },
    });
    return this.keysFor(db, grants.map((g) => g.permission_id));
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

/**
 * Set union, order-stable, duplicates removed.
 *
 * Deduplication is not cosmetic: two groups may grant the same key, and a caller comparing effective
 * sets (the seed's "restricts nothing" check, the widen-only proof) would otherwise see a difference
 * that is not one.
 */
function union(own: readonly string[], group: readonly string[]): string[] {
  return [...new Set([...own, ...group])];
}
