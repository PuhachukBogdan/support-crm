import { ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';
import type { ClientGrpc } from '@nestjs/microservices';
import type { Request } from 'express';
import { AccessManagementController } from './access-management.controller';
import type { EffectivePermsCache } from '../security/effective-perms.cache';
import type { ViewAsContext } from '../security/view-as.context';
import type { RequestClaims } from '../auth/auth.guard';

function make(grpc: Record<string, unknown>, viewAsRole: string | null = null) {
  const client = { getService: () => grpc } as unknown as ClientGrpc;
  const cache = { invalidate: jest.fn(async () => undefined) } as unknown as EffectivePermsCache;
  const viewAs = { get: jest.fn(async () => viewAsRole) } as unknown as ViewAsContext;
  const c = new AccessManagementController(client, cache, viewAs);
  c.onModuleInit();
  return c;
}
const req = (roles: string[]) =>
  ({ claims: { userId: 'god', accountId: 'acct-1', roles } as RequestClaims }) as Request & {
    claims?: RequestClaims;
  };

/**
 * US2 (feature 011, T022). The Access-Management read endpoints return the catalogue / role defaults
 * and are super-admin-only at the gateway tier.
 */
describe('AccessManagementController (reads)', () => {
  it('GET catalogue returns the grouped catalogue for a super-admin', async () => {
    const c = make({
      listPermissionCatalogue: () =>
        of({ categories: [{ category: 'crm', permissions: [{ key: 'crm.inbox.view', label: '', introducedVersion: 1 }] }] }),
    });

    const res = await c.catalogue(req(['super_admin']));

    expect(res.categories[0]!.category).toBe('crm');
  });

  it('GET role defaults returns the role template', async () => {
    const c = make({ listRoleDefaults: () => of({ permissionKeys: ['crm.inbox.view'] }) });
    const res = await c.roleDefaults('support_agent', req(['super_admin']));
    expect(res.permissionKeys).toEqual(['crm.inbox.view']);
  });

  it('rejects a non-super-admin (403)', async () => {
    const c = make({ listPermissionCatalogue: () => of({ categories: [] }) });
    await expect(c.catalogue(req(['support_agent']))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('under an active view-as preview (non-super role) → 403 even for a super-admin session (read-shaping, US5)', async () => {
    // Track-B finding: previewing as a non-super role must shape the admin surface too, not only block writes.
    const c = make({ listPermissionCatalogue: () => of({ categories: [] }) }, 'support_agent');
    await expect(c.catalogue(req(['super_admin']))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('under a view-as-super_admin preview → still allowed (200)', async () => {
    const c = make(
      { listPermissionCatalogue: () => of({ categories: [] }) },
      'super_admin',
    );
    await expect(c.catalogue(req(['super_admin']))).resolves.toBeDefined();
  });
});
