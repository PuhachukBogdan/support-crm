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
});
