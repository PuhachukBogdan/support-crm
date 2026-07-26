import {
  SEED_ACCOUNT_ID,
  SEED_AUTH_USER_ID,
  SEED_ROLE_ID,
  SEED_CREDENTIAL_ID,
  SEED_PLACEHOLDER_SECRET,
} from '@crm/common';
import { SYSTEM_CATALOGUE, ROLE_DEFAULTS } from '../src/rbac/catalogue';

/** Deterministic seed id for a role by key. `admin` keeps the historical SEED_ROLE_ID. */
const roleId = (key: string): string => (key === 'admin' ? SEED_ROLE_ID : `seed-role-${key}`);
/** Deterministic seed id for a permission by key. */
const permId = (key: string): string => `seed-perm-${key}`;

/**
 * Pure synthetic dataset for auth_db (feature 008; RBAC matrix added in feature 011). No I/O —
 * unit-testable on the dev box (Track A). All rows are synthetic + brand-neutral (Principles V/VI);
 * every tenant row carries the seed account. The runner (seed.ts) upserts these via the feature-007
 * account-scoped client. `roles[0]` stays the historical `admin`/SEED_ROLE_ID so 008/009 fixtures hold.
 */
export function buildSeed() {
  const roleKeys = Object.keys(ROLE_DEFAULTS);
  const roles = [
    { id: SEED_ROLE_ID, account_id: SEED_ACCOUNT_ID, key: 'admin', label: 'Administrator' },
    ...roleKeys
      .filter((k) => k !== 'admin')
      .map((key) => ({ id: roleId(key), account_id: SEED_ACCOUNT_ID, key, label: key })),
  ];

  // Feature 011 — the versioned permission catalogue + the role→permission default matrix.
  const permissions = SYSTEM_CATALOGUE.map((e) => ({
    id: permId(e.key),
    account_id: SEED_ACCOUNT_ID,
    category: e.category,
    key: e.key,
    label: e.label,
    introduced_version: 1,
  }));
  const rolePermissions = roleKeys.flatMap((key) =>
    [...ROLE_DEFAULTS[key]!].map((permKey) => ({
      role_id: roleId(key),
      permission_id: permId(permKey),
    })),
  );

  return {
    roles,
    permissions,
    rolePermissions,
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
