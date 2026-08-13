import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { RbacResolverService } from './resolver.service';
import { PermissionRegistryService } from './permission-registry.service';
import { RoleDefaultsService } from './role-defaults.service';
import { OverrideService } from './override.service';
import { RoleAssignmentService } from './role-assignment.service';
import { InvalidStaffCursor, StaffRepository } from './staff.repository';

// Request shapes as delivered by proto-loader (keepCase:false → camelCase).
interface ResolveRequest {
  accountId: string;
  userId: string;
  previewRole: string;
}
interface CatalogueRequest {
  accountId: string;
}
interface RoleDefaultsRequest {
  accountId: string;
  roleKey: string;
}
interface CallerCtx {
  callerAccountId: string;
  callerUserId: string;
  callerRoles: string[];
  /**
   * Feature 015: whether the caller was previewing another role (owner view-as). The audit entry records
   * the REAL user with this marker — never the previewed role, which nobody performed anything as.
   * View-as is read-only, so this should always be false on a mutation; recording it anyway means a
   * regression in that rule shows up in the trail instead of being invisible.
   */
  callerUnderPreview?: boolean;
}
interface SetRoleDefaultRequest extends CallerCtx {
  roleKey: string;
  permissionKey: string;
  grant: boolean;
}
interface PersonalizeRequest extends CallerCtx {
  userId: string;
  permissionKey: string;
  grant: boolean;
}
interface PersonalizeSelectionRequest extends CallerCtx {
  userIds: string[];
  permissionKey: string;
  grant: boolean;
}
interface ResetRequest extends CallerCtx {
  scope: string;
  userId: string;
  userIds: string[];
  roleKey: string;
}
interface AssignRoleRequest extends CallerCtx {
  userId: string;
  roleKey: string;
  op: string;
}

/** proto PermissionMode / RbacStatus enum names (enums:String) — the wire values the gateway receives. */
const MODE_WIRE: Record<'inherited' | 'standalone', string> = {
  inherited: 'PERMISSION_MODE_INHERITED',
  standalone: 'PERMISSION_MODE_STANDALONE',
};
const OK = 'RBAC_STATUS_OK';
const FORBIDDEN = 'RBAC_STATUS_FORBIDDEN';
const CROSS_ROLE = 'RBAC_STATUS_CROSS_ROLE';
const SUPER_ADMIN_UI_FORBIDDEN = 'RBAC_STATUS_SUPER_ADMIN_UI_FORBIDDEN';
const NOT_FOUND = 'RBAC_STATUS_NOT_FOUND';

const isSuperAdmin = (roles: string[] | undefined): boolean => !!roles?.includes('super_admin');

/**
 * `user | selection | role`, with `group` accepted as a **legacy synonym for `selection`**.
 *
 * A scope is a string VALUE, not a name, so widening it is additive and costs nothing. It is worth
 * doing because after feature 024 the product has a real `Group`, and a caller sending
 * `scope: "group"` while thinking of a group id is a plausible mistake that the strings alone would
 * never warn them about. Anything unrecognised falls back to `user`, which is the narrowest scope —
 * a typo must not silently widen a reset.
 */
export function normaliseResetScope(raw: string | undefined): 'user' | 'selection' | 'role' {
  if (raw === 'role') return 'role';
  if (raw === 'selection' || raw === 'group') return 'selection';
  return 'user';
}
const result = (status: string, affectedUserIds: string[] = [], message = '') => ({
  status,
  message,
  affectedUserIds,
});

/**
 * RBAC gRPC controller (feature 011). US1 resolver + US2 catalogue reads + US3 management mutations.
 * Management RPCs are **super-admin only, enforced server-side** (FR-018) — the caller's roles come
 * from the gateway's VALIDATED claims (Principle II). Returns enum NAMES on the wire (enums:String);
 * `affected_user_ids` lets the gateway invalidate those effective-permission caches (R-1). No
 * secret/PII ever appears here (Principle IV).
 */
@Controller()
export class RbacGrpcController {
  constructor(
    @Inject(RbacResolverService) private readonly resolver: RbacResolverService,
    @Inject(PermissionRegistryService) private readonly registry: PermissionRegistryService,
    @Inject(RoleDefaultsService) private readonly roleDefaults: RoleDefaultsService,
    @Inject(OverrideService) private readonly overrides: OverrideService,
    @Inject(RoleAssignmentService) private readonly roleAssignment: RoleAssignmentService,
    // W14 (3.8): the people list — the read every people-shaped mutation needed and nobody had.
    @Inject(StaffRepository) private readonly staff: StaffRepository,
  ) {}

  @GrpcMethod('AuthService', 'ResolveEffectivePermissions')
  async resolveRpc(req: ResolveRequest) {
    const r = await this.resolver.resolve(req.accountId, req.userId, req.previewRole || undefined);
    return {
      roleKey: r.roleKey,
      permissionKeys: r.permissionKeys,
      mode: MODE_WIRE[r.mode],
      isPreview: r.isPreview,
      readOnly: r.readOnly,
    };
  }

  // --- US2: catalogue / role defaults (gateway gates super-admin on the route) ---

  @GrpcMethod('AuthService', 'ListPermissionCatalogue')
  async listCatalogueRpc(req: CatalogueRequest) {
    const categories = await this.registry.listCatalogue(req.accountId);
    return {
      categories: categories.map((c) => ({
        category: c.category,
        permissions: c.permissions.map((p) => ({
          key: p.key,
          label: p.label,
          introducedVersion: p.introducedVersion,
        })),
      })),
    };
  }

  @GrpcMethod('AuthService', 'ListRoleDefaults')
  async listRoleDefaultsRpc(req: RoleDefaultsRequest) {
    const keys = await this.roleDefaults.list(req.accountId, req.roleKey);
    return { permissionKeys: keys ?? [] };
  }

  // --- US3: management (super-admin only, server-side) ---

  @GrpcMethod('AuthService', 'SetRoleDefault')
  async setRoleDefaultRpc(req: SetRoleDefaultRequest) {
    if (!isSuperAdmin(req.callerRoles)) return result(FORBIDDEN);
    const r = await this.roleDefaults.setRoleDefault(
      req.callerAccountId,
      req.roleKey,
      req.permissionKey,
      req.grant,
    );
    if (r.status === 'not_found') return result(NOT_FOUND);
    return result(OK, r.affectedUserIds);
  }

  @GrpcMethod('AuthService', 'PersonalizeUser')
  async personalizeUserRpc(req: PersonalizeRequest) {
    if (!isSuperAdmin(req.callerRoles)) return result(FORBIDDEN);
    const r = await this.overrides.personalizeUser(
      req.callerAccountId,
      { userId: req.callerUserId, underPreview: req.callerUnderPreview === true },
      req.userId,
      req.permissionKey,
      req.grant,
    );
    return this.overrideResult(r);
  }

  @GrpcMethod('AuthService', 'PersonalizeGroup')
  async personalizeSelectionRpc(req: PersonalizeSelectionRequest) {
    if (!isSuperAdmin(req.callerRoles)) return result(FORBIDDEN);
    const r = await this.overrides.personalizeSelection(
      req.callerAccountId,
      { userId: req.callerUserId, underPreview: req.callerUnderPreview === true },
      req.userIds ?? [],
      req.permissionKey,
      req.grant,
    );
    return this.overrideResult(r);
  }

  @GrpcMethod('AuthService', 'ResetToDefault')
  async resetRpc(req: ResetRequest) {
    if (!isSuperAdmin(req.callerRoles)) return result(FORBIDDEN);
    const r = await this.overrides.resetToDefault(
      req.callerAccountId,
      { userId: req.callerUserId, underPreview: req.callerUnderPreview === true },
      {
      scope: normaliseResetScope(req.scope),
      userId: req.userId,
      userIds: req.userIds ?? [],
      roleKey: req.roleKey,
    });
    return this.overrideResult(r);
  }

  /**
   * ⭐ W14 (roadmap 3.8) — the account's people.
   *
   * ── The gate is the CALLER's permission, forwarded by the gateway ────────────────────────────
   * `users.list.view` — the key whose label has always read *"View user list"* and which, until now,
   * gated only "may I see facts about somebody I already named". Deliberately NOT super-admin-only
   * like `AssignRole` beside it: seeing who works here is a supervisory read, while changing what
   * they may do is an ownership act, and collapsing the two would either hide the screen from every
   * teamlead or hand out role changes with it.
   *
   * ⚠️ Fail-closed on the account, like every tenant read in this service: no account context, no
   * people.
   */
  @GrpcMethod('AuthService', 'ListUsers')
  async listUsersRpc(
    req: { accountId?: string; pageToken?: string; pageSize?: number; callerPermissions?: string[] },
  ) {
    const accountId = (req?.accountId ?? '').trim();
    if (!accountId) return { users: [], nextPageToken: '' };
    if (!req?.callerPermissions?.includes('users.list.view')) {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }

    const size = !req.pageSize || req.pageSize <= 0 ? 50 : Math.min(Math.floor(req.pageSize), 100);
    try {
      const { rows, nextPageToken } = await this.staff.list(accountId, size, (req.pageToken ?? '').trim() || undefined);
      return {
        users: rows.map((u) => ({
          userId: u.id,
          email: u.email,
          displayName: u.displayName,
          status: u.status,
          roleKey: u.roleKey,
        })),
        nextPageToken,
      };
    } catch (err) {
      if (err instanceof InvalidStaffCursor) {
        throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid page token' });
      }
      throw err;
    }
  }

  @GrpcMethod('AuthService', 'AssignRole')
  async assignRoleRpc(req: AssignRoleRequest) {
    if (!isSuperAdmin(req.callerRoles)) return result(FORBIDDEN);
    const r = await this.roleAssignment.assignRole(
      req.callerAccountId,
      { userId: req.callerUserId, underPreview: req.callerUnderPreview === true },
      req.userId,
      req.roleKey,
      req.op === 'revoke' ? 'revoke' : 'assign',
    );
    if (r.status === 'super_admin_ui_forbidden') return result(SUPER_ADMIN_UI_FORBIDDEN);
    if (r.status === 'not_found') return result(NOT_FOUND);
    return result(OK, r.affectedUserIds);
  }

  private overrideResult(r: {
    status: 'ok' | 'cross_role' | 'not_found';
    affectedUserIds?: string[];
  }) {
    if (r.status === 'cross_role') return result(CROSS_ROLE);
    if (r.status === 'not_found') return result(NOT_FOUND);
    return result(OK, r.affectedUserIds ?? []);
  }
}
