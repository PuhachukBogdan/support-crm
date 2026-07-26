import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import type { Request } from 'express';
import { hasPermission, type EffectivePermissions } from '@crm/common';
import { AUTH_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { EffectivePermsCache } from './effective-perms.cache';
import { ViewAsContext } from './view-as.context';
import {
  ALLOW_UNDER_PREVIEW_KEY,
  REQUIRED_PERMISSION_KEY,
  REQUIRES_BRAND_PARAM_KEY,
} from './requires-permission.decorator';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface ResolveResponseWire {
  roleKey: string;
  permissionKeys: string[];
  mode: string; // PERMISSION_MODE_INHERITED | PERMISSION_MODE_STANDALONE
  isPreview: boolean;
  readOnly: boolean;
}
interface ResolveGrpc {
  resolveEffectivePermissions(data: {
    accountId: string;
    userId: string;
    previewRole: string;
  }): Observable<ResolveResponseWire>;
}

/**
 * Global RBAC enforcement guard (feature 011, T016/T017). Runs AFTER the AuthGuard (which sets
 * `req.claims`). Enforces authorization in the policy layer (Principle II) — NOT the UI. Only
 * routes annotated with `@RequiresPermission` / `@RequiresBrandParam` are gated; others pass.
 *
 * Resolution (R-1): read the caller's effective permissions from the Redis cache; on a miss call
 * `AuthService.ResolveEffectivePermissions` (Auth = source of truth) and cache the result. The
 * SAME decision the owning service enforces independently, so bypassing the gateway is still
 * blocked at the service tier (SC-001).
 */
@Injectable()
export class PermissionGuard implements CanActivate, OnModuleInit {
  private auth!: ResolveGrpc;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTH_CLIENT) private readonly client: ClientGrpc,
    @Inject(EffectivePermsCache) private readonly cache: EffectivePermsCache,
    @Inject(ViewAsContext) private readonly viewAs: ViewAsContext,
  ) {}

  onModuleInit(): void {
    this.auth = this.client.getService<ResolveGrpc>('AuthService');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const required = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const brandParam = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRES_BRAND_PARAM_KEY,
      [context.getHandler(), context.getClass()],
    );
    const allowUnderPreview =
      this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_UNDER_PREVIEW_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;

    const req = context
      .switchToHttp()
      .getRequest<
        Request & { claims?: RequestClaims; effective?: EffectivePermissions }
      >();
    const claims = req.claims;

    // View-as read-only enforcement (US5, R-5): while a preview is active for this caller, shape
    // reads as the previewed role AND refuse EVERY write (SC-009). The view-as control routes are
    // `@AllowUnderPreview` so the caller can always enter/exit and they resolve REAL permissions.
    let previewRole: string | undefined;
    if (claims && !allowUnderPreview) {
      const active = await this.viewAs.get(claims.accountId, claims.userId);
      if (active) {
        previewRole = active;
        const method = (req.method ?? '').toUpperCase();
        if (MUTATING.has(method)) throw new ForbiddenException(); // read-only preview.
      }
    }

    // Not permission-gated → pass (the global AuthGuard already required a session).
    if (!required && !brandParam) return true;
    if (!claims) throw new UnauthorizedException(); // fail closed (Principle II).

    // Brand/queue scope (FR-004): if the route names a brand param and the caller's brand scope is
    // known and excludes it → 403. (When claims.brands is absent, brand enforcement lands with the
    // Brands service — Phase 5; the permission check below still applies.)
    if (brandParam) {
      const brandId = (req.params as Record<string, string> | undefined)?.[brandParam];
      if (brandId && Array.isArray(claims.brands) && !claims.brands.includes(brandId)) {
        throw new ForbiddenException();
      }
    }

    if (required) {
      const eff = await this.resolve(claims.accountId, claims.userId, previewRole);
      if (!hasPermission(eff.permissionKeys, required)) throw new ForbiddenException();
      req.effective = eff;
    }
    return true;
  }

  /**
   * Effective-permission resolution. Normal path: cache-first, Auth on a miss (R-1). Preview path
   * (`previewRole` set): always resolve via Auth AS the previewed role and NEVER cache (a preview
   * must not poison the caller's real cached set).
   */
  private async resolve(
    accountId: string,
    userId: string,
    previewRole?: string,
  ): Promise<EffectivePermissions> {
    if (!previewRole) {
      const cached = await this.cache.get(accountId, userId);
      if (cached) return cached;
    }

    const res = await firstValueFrom(
      this.auth.resolveEffectivePermissions({ accountId, userId, previewRole: previewRole ?? '' }),
    );
    const eff: EffectivePermissions = {
      roleKey: res.roleKey,
      permissionKeys: res.permissionKeys ?? [],
      mode: res.mode === 'PERMISSION_MODE_STANDALONE' ? 'standalone' : 'inherited',
      isPreview: !!res.isPreview,
      readOnly: !!res.readOnly,
    };
    if (!previewRole) await this.cache.set(accountId, userId, eff);
    return eff;
  }
}
