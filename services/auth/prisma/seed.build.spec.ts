import { buildSeed } from './seed.build';
import { SEED_ACCOUNT_ID, SEED_AUTH_USER_ID, SEED_ROLE_ID } from '@crm/common';

/**
 * US1 (feature 008): the auth seed builder yields a coherent, account-scoped, synthetic dataset.
 * Pure — no DB (Track A). Fails before seed.build.ts exists.
 */
describe('auth seed builder', () => {
  const seed = buildSeed();

  it('every tenant row carries the seed account_id (SC-003)', () => {
    for (const row of [...seed.roles, ...seed.users, ...seed.credentials]) {
      expect(row.account_id).toBe(SEED_ACCOUNT_ID);
    }
  });

  it('the user + role are keyed by the shared ids (coherent graph)', () => {
    expect(seed.users[0]!.id).toBe(SEED_AUTH_USER_ID);
    expect(seed.roles[0]!.id).toBe(SEED_ROLE_ID);
    expect(seed.userRoles[0]).toEqual({ user_id: SEED_AUTH_USER_ID, role_id: SEED_ROLE_ID });
  });

  it('the credential secret is a placeholder, never a real secret (SC-004)', () => {
    expect(seed.credentials[0]!.secret_hash).toMatch(/PLACEHOLDER/);
  });

  it('seeds the full 7-role set + a permission catalogue (feature 011)', () => {
    const keys = seed.roles.map((r) => r.key).sort();
    expect(keys).toEqual(
      ['admin', 'am', 'shift_am', 'super_admin', 'support_agent', 'teamlead', 'vip_support'].sort(),
    );
    expect(seed.permissions.length).toBeGreaterThan(0);
    for (const p of seed.permissions) expect(p.account_id).toBe(SEED_ACCOUNT_ID);
  });

  it('seeds the feature-013 workflow keys with their role defaults', () => {
    const NEW_KEYS = ['crm.conversation.assign', 'crm.labels.manage', 'crm.templates.manage'];
    for (const key of NEW_KEYS) {
      expect(seed.permissions.some((p) => p.key === key)).toBe(true);
    }
    const roleId = (k: string) => seed.roles.find((r) => r.key === k)!.id;
    const holds = (role: string, key: string) =>
      seed.rolePermissions.some(
        (rp) => rp.role_id === roleId(role) && rp.permission_id === `seed-perm-${key}`,
      );
    // Operational roles route + label; authoring templates is lead/admin only (research R2).
    expect(holds('support_agent', 'crm.conversation.assign')).toBe(true);
    expect(holds('support_agent', 'crm.labels.manage')).toBe(true);
    expect(holds('support_agent', 'crm.templates.manage')).toBe(false);
    expect(holds('teamlead', 'crm.templates.manage')).toBe(true);
    expect(holds('admin', 'crm.templates.manage')).toBe(true);
  });

  it('the default matrix is coherent: only super_admin holds platform.role.manage (FR-018)', () => {
    const superAdmin = seed.roles.find((r) => r.key === 'super_admin')!;
    const others = seed.roles.filter((r) => r.key !== 'super_admin');
    const holdsRoleManage = (roleId: string) =>
      seed.rolePermissions.some(
        (rp) => rp.role_id === roleId && rp.permission_id === 'seed-perm-platform.role.manage',
      );
    expect(holdsRoleManage(superAdmin.id)).toBe(true);
    for (const r of others) expect(holdsRoleManage(r.id)).toBe(false);
  });
});
