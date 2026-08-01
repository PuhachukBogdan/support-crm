import { OverrideService } from './override.service';
import { RoleDefaultsService } from './role-defaults.service';
import { AuditRepository } from '../audit/audit.repository';
import type { PrismaService } from '../prisma.service';
import { makeFakePrisma } from '../../tests/support/auth-test-doubles';

function make(seed: Parameters<typeof makeFakePrisma>[0]) {
  const prisma = makeFakePrisma(seed) as unknown as PrismaService;
  const audit = new AuditRepository(prisma);
  const overrides = new OverrideService(prisma, audit, new RoleDefaultsService(prisma));
  return { overrides };
}

/**
 * US3 (feature 011, T028 / SC-005 / FR-011). A batch edit applies to a same-role SELECTION; a
 * selection spanning more than one role is refused (`cross_role`) server-side.
 *
 * ⚠️ Renamed from `override.group.spec.ts` by feature 024. Nothing here is about the `Group` ENTITY —
 * "group" only ever meant "several users picked in the admin panel", and keeping the old name would
 * have left the next reader believing group grants were already tested somewhere.
 */
describe('OverrideService.personalizeSelection (single-role constraint)', () => {
  it('applies to a same-role group', async () => {
    const { overrides } = make({
      users: [{ id: 'a' }, { id: 'b' }],
      permissions: [{ key: 'reports.export' }, { key: 'crm.inbox.view' }],
      rolePermissions: [{ roleKey: 'support_agent', permKey: 'crm.inbox.view' }],
      userRoles: [
        { user_id: 'a', roleKey: 'support_agent' },
        { user_id: 'b', roleKey: 'support_agent' },
      ],
    });

    const res = await overrides.personalizeSelection('acct-1', { userId: 'god' }, ['a', 'b'], 'reports.export', true);

    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.affectedUserIds.sort()).toEqual(['a', 'b']);
  });

  it('rejects a group spanning more than one role (cross_role)', async () => {
    const { overrides } = make({
      users: [{ id: 'a' }, { id: 'c' }],
      permissions: [{ key: 'reports.export' }],
      userRoles: [
        { user_id: 'a', roleKey: 'support_agent' },
        { user_id: 'c', roleKey: 'teamlead' },
      ],
    });

    const res = await overrides.personalizeSelection('acct-1', { userId: 'god' }, ['a', 'c'], 'reports.export', true);

    expect(res.status).toBe('cross_role');
  });
});
