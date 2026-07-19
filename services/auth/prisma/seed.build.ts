import {
  SEED_ACCOUNT_ID,
  SEED_AUTH_USER_ID,
  SEED_ROLE_ID,
  SEED_CREDENTIAL_ID,
  SEED_PLACEHOLDER_SECRET,
} from '@crm/common';

/**
 * Pure synthetic dataset for auth_db (feature 008). No I/O — unit-testable on the dev box (Track A).
 * All rows are synthetic + brand-neutral (Principles V/VI); every tenant row carries the seed account.
 * The runner (seed.ts) upserts these via the feature-007 account-scoped client.
 */
export function buildSeed() {
  return {
    roles: [{ id: SEED_ROLE_ID, account_id: SEED_ACCOUNT_ID, key: 'admin', label: 'Administrator' }],
    users: [
      {
        id: SEED_AUTH_USER_ID,
        account_id: SEED_ACCOUNT_ID,
        email: 'admin@example.test',
        display_name: 'Seed Admin',
        status: 'active',
        mfa_enabled: false,
      },
    ],
    credentials: [
      {
        id: SEED_CREDENTIAL_ID,
        account_id: SEED_ACCOUNT_ID,
        user_id: SEED_AUTH_USER_ID,
        type: 'password',
        secret_hash: SEED_PLACEHOLDER_SECRET, // labelled placeholder — NOT a real secret
      },
    ],
    userRoles: [{ user_id: SEED_AUTH_USER_ID, role_id: SEED_ROLE_ID }],
  };
}

export type AuthSeed = ReturnType<typeof buildSeed>;
