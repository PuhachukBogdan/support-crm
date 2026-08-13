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

  /**
   * MVP block W1 (roadmap 1.7) — a seeded human being must be able to SIGN IN.
   *
   * The old shape is asserted above and still holds with no argument, which is the point: the
   * placeholder is the default and working logins are opt-in.
   */
  describe('dev logins (roadmap 1.7)', () => {
    it('⭐ with a hash supplied, EVERY seeded user gets a credential — the agents had none at all', () => {
      const withLogins = buildSeed('$argon2id$fake-but-shaped-like-a-hash');

      const userIds = withLogins.users.map((u) => u.id).sort();
      const credUserIds = withLogins.credentials.map((c) => c.user_id).sort();
      expect(credUserIds).toEqual(userIds);
      expect(withLogins.credentials).toHaveLength(4); // admin + three routing agents
      for (const cred of withLogins.credentials) {
        expect(cred.secret_hash).toBe('$argon2id$fake-but-shaped-like-a-hash');
        expect(cred.secret_hash).not.toMatch(/PLACEHOLDER/);
        expect(cred.account_id).toBe(SEED_ACCOUNT_ID);
      }
    });

    it('credential ids are deterministic, so a second seed run updates rather than accumulates', () => {
      const a = buildSeed('h');
      const b = buildSeed('h');
      expect(a.credentials.map((c) => c.id)).toEqual(b.credentials.map((c) => c.id));
      expect(new Set(a.credentials.map((c) => c.id)).size).toBe(a.credentials.length);
    });

    it('without a hash the dataset is UNCHANGED — no default password anywhere', () => {
      const plain = buildSeed();
      const explicitlyNothing = buildSeed(undefined);

      expect(plain.credentials).toHaveLength(1);
      expect(plain.credentials[0]!.secret_hash).toMatch(/PLACEHOLDER/);
      // No hidden default: omitting the argument and passing nothing are the same dataset, so there is
      // no fallback password a reader could miss.
      expect(explicitlyNothing).toEqual(plain);
      // Every credential is the labelled placeholder — nothing verifiable slipped in.
      for (const cred of plain.credentials) expect(cred.secret_hash).toMatch(/PLACEHOLDER/);
    });
  });

  it('seeds the full role set + a permission catalogue (011, plus 038’s newcomer)', () => {
    const keys = seed.roles.map((r) => r.key).sort();
    // ⭐ W31 / 038 added `newcomer` — the ONLY role the staff-provisioning API can produce, and
    // deliberately the weakest one in the catalogue (a machine holding a shared secret mints it).
    // The exact-membership assertion is why this line had to be edited rather than merely passing:
    // a role appearing in this product is a visible act, and one that arrives with a machine path
    // doubly so.
    expect(keys).toEqual(
      ['admin', 'am', 'newcomer', 'shift_am', 'super_admin', 'support_agent', 'teamlead', 'vip_support'].sort(),
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
