import { Controller, Inject } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { RbacResolverService } from './resolver.service';
import { PermissionRegistryService } from './permission-registry.service';
import { RoleDefaultsService } from './role-defaults.service';
import { OverrideService } from './override.service';
import { RoleAssignmentService } from './role-assignment.service';

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
interface PersonalizeGroupRequest extends CallerCtx {
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
      req.callerUserId,
      req.userId,
      req.permissionKey,
      req.grant,
    );
    return this.overrideResult(r);
  }

  @GrpcMethod('AuthService', 'PersonalizeGroup')
  async personalizeGroupRpc(req: PersonalizeGroupRequest) {
    if (!isSuperAdmin(req.callerRoles)) return result(FORBIDDEN);
    const r = await this.overrides.personalizeGroup(
      req.callerAccountId,
      req.callerUserId,
      req.userIds ?? [],
      req.permissionKey,
      req.grant,
    );
    return this.overrideResult(r);
  }

  @GrpcMethod('AuthService', 'ResetToDefault')
  async resetRpc(req: ResetRequest) {
    if (!isSuperAdmin(req.callerRoles)) return result(FORBIDDEN);
    const r = await this.overrides.resetToDefault(req.callerAccountId, req.callerUserId, {
      scope: (req.scope as 'user' | 'group' | 'role') || 'user',
      userId: req.userId,
      userIds: req.userIds ?? [],
      roleKey: req.roleKey,
    });
    return this.overrideResult(r);
  }

  @GrpcMethod('AuthService', 'AssignRole')
  async assignRoleRpc(req: AssignRoleRequest) {
    if (!isSuperAdmin(req.callerRoles)) return result(FORBIDDEN);
    const r = await this.roleAssignment.assignRole(
      req.callerAccountId,
      req.callerUserId,
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
