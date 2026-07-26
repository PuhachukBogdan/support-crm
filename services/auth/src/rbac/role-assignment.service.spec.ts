import { RoleAssignmentService } from './role-assignment.service';
import { AuditRepository } from '../audit/audit.repository';
import type { PrismaService } from '../prisma.service';
import { makeFakePrisma } from '../../tests/support/auth-test-doubles';

function make(seed: Parameters<typeof makeFakePrisma>[0]) {
  const fake = makeFakePrisma(seed);
  const prisma = fake as unknown as PrismaService;
  const svc = new RoleAssignmentService(prisma, new AuditRepository(prisma));
  return { svc, fake };
}

/**
 * US3 (feature 011, T030 / SC-010). Assign/change/revoke a user's role — but `super_admin` is never
 * assignable through the app (whitelist only, 0033/FR-018).
 */
describe('RoleAssignmentService', () => {
  it('refuses assigning super_admin (whitelist only)', async () => {
    const { svc, fake } = make({ users: [{ id: 'u-1' }], roles: [{ key: 'super_admin' }] });

    const res = await svc.assignRole('acct-1', { userId: 'god' }, 'u-1', 'super_admin', 'assign');

    expect(res.status).toBe('super_admin_ui_forbidden');
    expect(fake._tables.auditEntries).toHaveLength(0); // refused before any write
  });

  it('assigns a normal role and audits it', async () => {
    const { svc, fake } = make({ users: [{ id: 'u-1' }], roles: [{ key: 'teamlead' }] });

    const res = await svc.assignRole('acct-1', { userId: 'god' }, 'u-1', 'teamlead', 'assign');

    expect(res.status).toBe('ok');
    expect(fake._tables.userRoles).toContainEqual({ user_id: 'u-1', roleKey: 'teamlead' });
    expect(fake._tables.auditEntries).toHaveLength(1);
  });

  it('revokes a role', async () => {
    const { svc, fake } = make({
      users: [{ id: 'u-1' }],
      userRoles: [{ user_id: 'u-1', roleKey: 'teamlead' }],
    });

    const res = await svc.assignRole('acct-1', { userId: 'god' }, 'u-1', 'teamlead', 'revoke');

    expect(res.status).toBe('ok');
    expect(fake._tables.userRoles).toHaveLength(0);
  });
});
