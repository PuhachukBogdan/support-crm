import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type ClientGrpc } from '@nestjs/microservices';
import { of } from 'rxjs';
import type { EffectivePermissions } from '@crm/common';
import { PermissionGuard } from './permission.guard';
import { EffectivePermsCache } from './effective-perms.cache';
import { ViewAsContext } from './view-as.context';
import {
  ALLOW_UNDER_PREVIEW_KEY,
  REQUIRED_PERMISSION_KEY,
  REQUIRES_BRAND_PARAM_KEY,
} from './requires-permission.decorator';

/**
 * US1 (feature 011, T013). The gateway permission guard enforces authorization server-side:
 * missing permission → 403, present → pass, no session → 401, brand out-of-scope → 403. Only
 * annotated routes are gated. Effective permissions come from the cache (or Auth on a miss).
 */
type ReqShape = {
  claims?: { userId: string; accountId: string; roles: string[]; brands?: string[] };
  params?: Record<string, string>;
  method?: string;
};

function makeGuard(opts: {
  cacheHit?: EffectivePermissions | null;
  grpcResolve?: EffectivePermissions;
  previewRole?: string | null;
}) {
  const cache = {
    get: jest.fn().mockResolvedValue(opts.cacheHit ?? null),
    set: jest.fn().mockResolvedValue(undefined),
  } as unknown as EffectivePermsCache;

  const resolveEffectivePermissions = jest.fn(() =>
    of({
      roleKey: opts.grpcResolve?.roleKey ?? '',
      permissionKeys: opts.grpcResolve?.permissionKeys ?? [],
      mode: 'PERMISSION_MODE_INHERITED',
      isPreview: !!opts.previewRole,
      readOnly: !!opts.previewRole,
    }),
  );
  const client = {
    getService: () => ({ resolveEffectivePermissions }),
  } as unknown as ClientGrpc;

  const viewAs = {
    get: jest.fn().mockResolvedValue(opts.previewRole ?? null),
    set: jest.fn().mockResolvedValue(undefined),
    clear: jest.fn().mockResolvedValue(undefined),
  } as unknown as ViewAsContext;

  const reflector = new Reflector();
  const guard = new PermissionGuard(reflector, client, cache, viewAs);
  guard.onModuleInit();
  return { guard, reflector, cache, resolveEffectivePermissions, viewAs };
}

function makeContext(
  reflector: Reflector,
  meta: { required?: string; brandParam?: string; allowUnderPreview?: boolean },
  req: ReqShape,
): ExecutionContext {
  jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
    if (key === REQUIRED_PERMISSION_KEY) return meta.required;
    if (key === REQUIRES_BRAND_PARAM_KEY) return meta.brandParam;
    if (key === ALLOW_UNDER_PREVIEW_KEY) return meta.allowUnderPreview;
    return undefined;
  });
  return {
    getType: () => 'http',
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const CLAIMS = { userId: 'u-1', accountId: 'acct-1', roles: ['support_agent'] };

describe('PermissionGuard', () => {
  it('passes a route with no permission metadata (not gated)', async () => {
    const { guard, reflector, cache } = makeGuard({});
    const ctx = makeContext(reflector, {}, { claims: CLAIMS });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(cache.get).not.toHaveBeenCalled();
  });

  it('passes when the caller HAS the required permission (cache hit)', async () => {
    const eff: EffectivePermissions = {
      roleKey: 'support_agent',
      permissionKeys: ['tickets.view'],
      mode: 'inherited',
      isPreview: false,
      readOnly: false,
    };
    const { guard, reflector } = makeGuard({ cacheHit: eff });
    const ctx = makeContext(reflector, { required: 'tickets.view' }, { claims: CLAIMS });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('403 when the caller LACKS the required permission', async () => {
    const eff: EffectivePermissions = {
      roleKey: 'support_agent',
      permissionKeys: ['tickets.view'],
      mode: 'inherited',
      isPreview: false,
      readOnly: false,
    };
    const { guard, reflector } = makeGuard({ cacheHit: eff });
    const ctx = makeContext(reflector, { required: 'settings.manage' }, { claims: CLAIMS });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('401 when there is no session/claims', async () => {
    const { guard, reflector } = makeGuard({});
    const ctx = makeContext(reflector, { required: 'settings.manage' }, {});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('403 when the requested brand is outside the caller brand scope (FR-004)', async () => {
    const { guard, reflector } = makeGuard({});
    const ctx = makeContext(
      reflector,
      { brandParam: 'brandId' },
      { claims: { ...CLAIMS, brands: ['brand-A'] }, params: { brandId: 'brand-B' } },
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('resolves via Auth on a cache MISS, then enforces (R-1)', async () => {
    const { guard, reflector, resolveEffectivePermissions, cache } = makeGuard({
      cacheHit: null,
      grpcResolve: {
        roleKey: 'admin',
        permissionKeys: ['settings.manage'],
        mode: 'inherited',
        isPreview: false,
        readOnly: false,
      },
    });
    const ctx = makeContext(reflector, { required: 'settings.manage' }, { claims: CLAIMS });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(resolveEffectivePermissions).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledTimes(1);
  });

  // --- US5: view-as read-only preview (SC-009) ---

  it('blocks ANY write while a preview is active (read-only, SC-009)', async () => {
    const { guard, reflector } = makeGuard({ previewRole: 'support_agent' });
    const ctx = makeContext(reflector, {}, { claims: CLAIMS, method: 'POST' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('under preview, a GET resolves AS the previewed role (bypassing the real cache)', async () => {
    const { guard, reflector, resolveEffectivePermissions, cache } = makeGuard({
      previewRole: 'support_agent',
      grpcResolve: { roleKey: 'support_agent', permissionKeys: ['crm.inbox.view'], mode: 'inherited', isPreview: true, readOnly: true },
    });
    const ctx = makeContext(
      reflector,
      { required: 'crm.inbox.view' },
      { claims: CLAIMS, method: 'GET' },
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(cache.get).not.toHaveBeenCalled(); // preview never touches the caller's real cache
    expect(resolveEffectivePermissions).toHaveBeenCalledWith(
      expect.objectContaining({ previewRole: 'support_agent' }),
    );
  });

  it('does NOT block a write on an @AllowUnderPreview route (enter/exit preview)', async () => {
    const { guard, reflector } = makeGuard({ previewRole: 'support_agent' });
    const ctx = makeContext(
      reflector,
      { allowUnderPreview: true },
      { claims: CLAIMS, method: 'DELETE' },
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
