import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  OnModuleInit,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import type { Request } from 'express';
import { AUTH_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { EffectivePermsCache } from '../security/effective-perms.cache';
import { ViewAsContext } from '../security/view-as.context';
import { RequiresPermission } from '../security/requires-permission.decorator';
import type { EffectivePermissions } from '@crm/common';

interface CatalogueWire {
  categories: { category: string; permissions: { key: string; label: string; introducedVersion: number }[] }[];
}
interface RoleDefaultsWire {
  permissionKeys: string[];
}
interface MutationWire {
  status: string; // RBAC_STATUS_*
  message: string;
  affectedUserIds: string[];
}
interface CallerCtx {
  callerAccountId: string;
  callerUserId: string;
  callerRoles: string[];
}
interface RbacGrpc {
  listPermissionCatalogue(d: { accountId: string }): Observable<CatalogueWire>;
  listRoleDefaults(d: { accountId: string; roleKey: string }): Observable<RoleDefaultsWire>;
  // ⭐ W28 (9.8): the same rpc the guard's own resolution uses, here for ANOTHER user — the grid's
  // read. `previewRole` is deliberately never sent from this edge.
  resolveEffectivePermissions(d: { accountId: string; userId: string; previewRole: string }): Observable<{
    roleKey?: string;
    permissionKeys?: string[];
    mode?: number | string;
    groupPermissionKeys?: string[];
    basePermissionKeys?: string[];
  }>;
  setRoleDefault(d: CallerCtx & { roleKey: string; permissionKey: string; grant: boolean }): Observable<MutationWire>;
  personalizeUser(d: CallerCtx & { userId: string; permissionKey: string; grant: boolean }): Observable<MutationWire>;
  // ⚠️ `personalizeGroup` is the WIRE name (rpc PersonalizeGroup) and means "a hand-picked BATCH OF
  // USERS" — it is NOT the Group ENTITY of feature 024, which has its own edge in `../groups/`. The rpc
  // cannot be renamed without tripping `buf breaking`, so the collision is declared instead. The
  // handler below is `personalizeSelection`.
  personalizeGroup(d: CallerCtx & { userIds: string[]; permissionKey: string; grant: boolean }): Observable<MutationWire>;
  resetToDefault(d: CallerCtx & { scope: string; userId: string; userIds: string[]; roleKey: string }): Observable<MutationWire>;
  assignRole(d: CallerCtx & { userId: string; roleKey: string; op: string }): Observable<MutationWire>;
  // ⭐ W14 (roadmap 3.8): the people list — the read every people-shaped mutation needed and
  // nobody had. Carries the caller's permissions so `auth` gates it on `users.list.view`.
  listUsers(d: {
    accountId: string;
    pageToken: string;
    pageSize: number;
    callerPermissions: string[];
  }): Observable<{ users?: unknown[]; nextPageToken?: string }>;
}

/**
 * Access-Management edge (feature 011, US2/US3 — ADR 0034). The admin-panel REST surface over the
 * Auth RBAC gRPC. GUARDED super-admin-only at BOTH tiers: this controller rejects a non-super-admin
 * (fast, gateway), and every Auth mutation RPC re-checks the caller roles (authoritative, FR-018).
 * The gateway stays a thin proxy (Principle VIII); it additionally invalidates the affected users'
 * effective-permission cache after a successful mutation (R-1 freshness). Caller identity comes from
 * the VALIDATED claims, never the body (Principle II).
 */
@Controller('admin/access')
export class AccessManagementController implements OnModuleInit {
  private auth!: RbacGrpc;

  constructor(
    @Inject(AUTH_CLIENT) private readonly client: ClientGrpc,
    @Inject(EffectivePermsCache) private readonly cache: EffectivePermsCache,
    @Inject(ViewAsContext) private readonly viewAs: ViewAsContext,
  ) {}

  onModuleInit(): void {
    this.auth = this.client.getService<RbacGrpc>('AuthService');
  }

  /** Resolve the caller + enforce the super-admin gate (FR-018). **Preview-aware (US5/R-5):** while a
   * view-as preview is active the EFFECTIVE role is the previewed role, so previewing as a non-super
   * role correctly 403s the Access-Management surface too — reads are shaped to the role, not just
   * writes blocked. Exit is always possible via the `@AllowUnderPreview` view-as routes. */
  private async caller(req: Request & { claims?: RequestClaims }): Promise<RequestClaims> {
    const claims = req.claims;
    if (!claims) throw new ForbiddenException(); // fail closed (Principle II).
    const preview = await this.viewAs.get(claims.accountId, claims.userId);
    const effectiveRoles = preview ? [preview] : (claims.roles ?? []);
    if (!effectiveRoles.includes('super_admin')) throw new ForbiddenException(); // FR-018.
    return claims;
  }

  private ctx(claims: RequestClaims): CallerCtx {
    return {
      callerAccountId: claims.accountId,
      callerUserId: claims.userId,
      callerRoles: claims.roles ?? [],
    };
  }

  // --- US2 reads ---

  /**
   * ⭐ W14 (roadmap 3.8) — the account's people.
   *
   * ⚠️ Gated by `users.list.view` and NOT by this controller's super-admin `caller()` check: seeing
   * who works here is a supervisory read (the key's label has always said *"View user list"*),
   * while changing what somebody may do is an ownership act. Collapsing them would either hide the
   * screen from every teamlead or hand out role changes along with it — so this one route on the
   * access-management edge is permission-gated while its neighbours stay role-gated, and that
   * difference is deliberate rather than an oversight.
   */
  @Get('users')
  @RequiresPermission('users.list.view')
  async listUsers(
    @Query() query: { pageSize?: string; pageToken?: string },
    @Req() req: Request & { claims?: RequestClaims; effective?: EffectivePermissions },
  ) {
    const accountId = req.claims?.accountId ?? '';
    const size = Number.parseInt(query?.pageSize ?? '', 10);
    if (query?.pageSize !== undefined && (!Number.isInteger(size) || size <= 0)) {
      throw new BadRequestException('pageSize must be a positive integer');
    }
    return firstValueFrom(
      this.auth.listUsers({
        accountId,
        pageToken: typeof query?.pageToken === 'string' ? query.pageToken : '',
        pageSize: Number.isInteger(size) && size > 0 ? size : 0,
        // The service re-checks: a call that skipped this edge carries no permissions and is refused.
        callerPermissions: req.effective?.permissionKeys ?? [],
      }),
    );
  }

  @Get('catalogue')
  async catalogue(@Req() req: Request & { claims?: RequestClaims }) {
    const claims = await this.caller(req);
    return firstValueFrom(this.auth.listPermissionCatalogue({ accountId: claims.accountId }));
  }

  @Get('roles/:role/defaults')
  async roleDefaults(@Param('role') role: string, @Req() req: Request & { claims?: RequestClaims }) {
    const claims = await this.caller(req);
    return firstValueFrom(
      this.auth.listRoleDefaults({ accountId: claims.accountId, roleKey: role }),
    );
  }

  /**
   * ⭐ W28 (9.8) — ONE person's permission facts, for the grid. The read the engine never exposed:
   * the resolver served only the caller's own gate. Super-admin gated like its sibling writes —
   * reading what a colleague may do is the same surface as changing it (R45's window).
   *
   * The BASE term and the GROUP term travel separately, both FROM THE RESOLVER: a key granted via
   * membership renders as «via group», never as a toggle — toggling it off here would "spring back"
   * (the union is live, 0039 grants-only) and read as a broken switch. The base is NOT derived as
   * `effective − group` anywhere: that subtraction loses a key present in both terms, and the
   * toggle reflects the base (what per-person editing controls).
   */
  @Get('users/:id/permissions')
  async userPermissions(@Param('id') id: string, @Req() req: Request & { claims?: RequestClaims }) {
    const claims = await this.caller(req);
    const r = await firstValueFrom(
      this.auth.resolveEffectivePermissions({
        accountId: claims.accountId,
        userId: id,
        previewRole: '',
      }),
    );
    return {
      roleKey: r.roleKey ?? '',
      // The wire mode arrives as a NAME or a number (the enums:String lesson) — normalised here.
      mode:
        r.mode === 2 || r.mode === 'PERMISSION_MODE_STANDALONE' ? 'standalone' : 'inherited',
      effectiveKeys: r.permissionKeys ?? [],
      baseKeys: r.basePermissionKeys ?? [],
      groupKeys: r.groupPermissionKeys ?? [],
    };
  }

  // --- US3 mutations ---

  @Put('roles/:role/permissions')
  async setRoleDefault(
    @Param('role') role: string,
    @Body() body: { permissionKey: string; grant: boolean },
    @Req() req: Request & { claims?: RequestClaims },
  ) {
    const claims = await this.caller(req);
    const r = await firstValueFrom(
      this.auth.setRoleDefault({
        ...this.ctx(claims),
        roleKey: role,
        permissionKey: body.permissionKey,
        grant: body.grant,
      }),
    );
    return this.finish(claims.accountId, r);
  }

  @Put('users/:id/permissions')
  async personalizeUser(
    @Param('id') id: string,
    @Body() body: { permissionKey: string; grant: boolean },
    @Req() req: Request & { claims?: RequestClaims },
  ) {
    const claims = await this.caller(req);
    const r = await firstValueFrom(
      this.auth.personalizeUser({
        ...this.ctx(claims),
        userId: id,
        permissionKey: body.permissionKey,
        grant: body.grant,
      }),
    );
    return this.finish(claims.accountId, r);
  }

  @Put('groups/permissions')
  async personalizeSelection(
    @Body() body: { userIds: string[]; permissionKey: string; grant: boolean },
    @Req() req: Request & { claims?: RequestClaims },
  ) {
    const claims = await this.caller(req);
    const r = await firstValueFrom(
      this.auth.personalizeGroup({
        ...this.ctx(claims),
        userIds: body.userIds ?? [],
        permissionKey: body.permissionKey,
        grant: body.grant,
      }),
    );
    return this.finish(claims.accountId, r);
  }

  @Post('reset')
  async reset(
    @Body() body: { scope: string; userId?: string; userIds?: string[]; roleKey?: string },
    @Req() req: Request & { claims?: RequestClaims },
  ) {
    const claims = await this.caller(req);
    const r = await firstValueFrom(
      this.auth.resetToDefault({
        ...this.ctx(claims),
        scope: body.scope,
        userId: body.userId ?? '',
        userIds: body.userIds ?? [],
        roleKey: body.roleKey ?? '',
      }),
    );
    return this.finish(claims.accountId, r);
  }

  @Put('users/:id/role')
  async assignRole(
    @Param('id') id: string,
    @Body() body: { roleKey: string; op: string },
    @Req() req: Request & { claims?: RequestClaims },
  ) {
    const claims = await this.caller(req);
    const r = await firstValueFrom(
      this.auth.assignRole({ ...this.ctx(claims), userId: id, roleKey: body.roleKey, op: body.op }),
    );
    return this.finish(claims.accountId, r);
  }

  /** Map the RBAC status → HTTP, and on success invalidate the affected users' perm cache (R-1). */
  private async finish(accountId: string, r: MutationWire) {
    switch (r.status) {
      case 'RBAC_STATUS_OK':
        await Promise.all(
          (r.affectedUserIds ?? []).map((uid) => this.cache.invalidate(accountId, uid)),
        );
        return { status: 'ok', affectedUserIds: r.affectedUserIds ?? [] };
      case 'RBAC_STATUS_CROSS_ROLE':
        throw new ConflictException('group spans more than one role');
      case 'RBAC_STATUS_NOT_FOUND':
        throw new NotFoundException();
      // FORBIDDEN + SUPER_ADMIN_UI_FORBIDDEN both map to 403.
      default:
        throw new ForbiddenException();
    }
  }
}
