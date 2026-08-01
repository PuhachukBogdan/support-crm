import { ConflictException, ForbiddenException } from '@nestjs/common';
import { of } from 'rxjs';
import type { ClientGrpc } from '@nestjs/microservices';
import type { Request } from 'express';
import { AccessManagementController } from './access-management.controller';
import type { EffectivePermsCache } from '../security/effective-perms.cache';
import type { ViewAsContext } from '../security/view-as.context';
import type { RequestClaims } from '../auth/auth.guard';

function make(grpc: Record<string, unknown>) {
  const invalidate = jest.fn(async () => undefined);
  const client = { getService: () => grpc } as unknown as ClientGrpc;
  const cache = { invalidate } as unknown as EffectivePermsCache;
  const viewAs = { get: jest.fn(async () => null) } as unknown as ViewAsContext;
  const c = new AccessManagementController(client, cache, viewAs);
  c.onModuleInit();
  return { c, invalidate };
}
const req = (roles: string[]) =>
  ({ claims: { userId: 'god', accountId: 'acct-1', roles } as RequestClaims }) as Request & {
    claims?: RequestClaims;
  };

/**
 * US3 (feature 011, T032 / SC-005, SC-010, R-1). Management writes are super-admin-only; a
 * cross-role group → 409; a super_admin-via-UI assignment → 403; and a successful mutation
 * invalidates the affected users' effective-permission cache.
 */
describe('AccessManagementController (writes)', () => {
  it('a non-super-admin is refused (403) before any RPC', async () => {
    const personalizeUser = jest.fn();
    const { c } = make({ personalizeUser });
    await expect(
      c.personalizeUser('u-1', { permissionKey: 'reports.export', grant: true }, req(['teamlead'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(personalizeUser).not.toHaveBeenCalled();
  });

  it('OK invalidates the affected users’ cache (R-1 freshness)', async () => {
    const { c, invalidate } = make({
      personalizeUser: () => of({ status: 'RBAC_STATUS_OK', message: '', affectedUserIds: ['u-1'] }),
    });

    const res = await c.personalizeUser(
      'u-1',
      { permissionKey: 'reports.export', grant: true },
      req(['super_admin']),
    );

    expect(res).toEqual({ status: 'ok', affectedUserIds: ['u-1'] });
    expect(invalidate).toHaveBeenCalledWith('acct-1', 'u-1');
  });

  it('a cross-role group → 409', async () => {
    const { c } = make({
      // ⚠️ The wire name, mirroring the rpc. "Group" here = a BATCH OF SELECTED USERS, NOT the
      // Group ENTITY (feature 024). See the note in access-management.controller.ts.
      personalizeGroup: () => of({ status: 'RBAC_STATUS_CROSS_ROLE', message: '', affectedUserIds: [] }),
    });
    await expect(
      c.personalizeSelection(
        { userIds: ['a', 'b'], permissionKey: 'reports.export', grant: true },
        req(['super_admin']),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('assigning super_admin via UI → 403', async () => {
    const { c } = make({
      assignRole: () =>
        of({ status: 'RBAC_STATUS_SUPER_ADMIN_UI_FORBIDDEN', message: '', affectedUserIds: [] }),
    });
    await expect(
      c.assignRole('u-1', { roleKey: 'super_admin', op: 'assign' }, req(['super_admin'])),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
