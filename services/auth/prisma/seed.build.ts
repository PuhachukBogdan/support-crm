import {
  SEED_ACCOUNT_ID,
  SEED_AUTH_USER_ID,
  SEED_ROLE_ID,
  SEED_CREDENTIAL_ID,
  SEED_PLACEHOLDER_SECRET,
  SEED_GROUP_A_ID,
  SEED_GROUP_B_ID,
  SEED_ROUTING_USER_IDS,
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
/**
 * ⭐ MVP block W1 (roadmap 1.7) — WHY THIS PARAMETER EXISTS.
 *
 * Until now this file wrote `SEED_PLACEHOLDER_SECRET` into the one credential it created, so **no
 * seeded user could sign in**, and only the seed admin had a credential at all. Nobody noticed for
 * eleven features because Track A never signs in and each live script built its own user — until a
 * round needed to read a queue *as an AM* and found there was no way to be anybody. A separate shell
 * script (`deploy/local/seed-role-logins.sh`) then created six real logins through the API, which
 * works and is not a fixture: a database restored from the seed alone still has nobody who can log in.
 *
 * ⚠️ **A hash is passed IN rather than computed here, and the default is deliberately absent.**
 * `buildSeed()` is pure and unit-testable on the dev box (no I/O, no argon2); the runner supplies the
 * hash only when `SEED_DEV_PASSWORD` is set. With the variable unset the behaviour is exactly what it
 * was — one credential, placeholder, nobody can log in. So a seed run against anything but a dev box
 * cannot silently mint working passwords, and the precedent is `APP_BASE_URL` (feature 028):
 * introduced as required config with **no default**, because a guessed one produces something that
 * looks perfect and is wrong.
 *
 * ⓘ **This is not an MFA bypass.** Login is two-step for every role (roadmap 3.11): the password gets
 * a seeded human being to the code step, and the code still has to arrive by mail and be read.
 */
export function buildSeed(devPasswordHash?: string) {
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
      // Feature 024: three agents, so a group is a pool with more than one person in it. Without
      // them a "fair rotation over a group" scenario has nothing to be fair between.
      //
      // ⚠️ The addresses are prefixed `seed-`, and that is a correction rather than a style choice.
      // The first draft used `agent1@example.test`, which COLLIDED on the live box with a user an
      // earlier feature's run had created by hand — and because the upsert keys on `id` while the
      // unique is `(account_id, email)`, the collision surfaced as a P2002 that aborted the seed
      // before it reached the groups. A seed must not compete for names a human would plausibly use.
      ...SEED_ROUTING_USER_IDS.map((id, i) => ({
        id,
        account_id: SEED_ACCOUNT_ID,
        email: `seed-agent${i + 1}@example.test`,
        display_name: `Seed Agent ${i + 1}`,
        status: 'active',
        mfa_enabled: false,
      })),
    ],
    /**
     * One credential per seeded user when a dev password hash was supplied; otherwise the historical
     * single placeholder row.
     *
     * ⚠️ The three routing agents had **no credential row at all**, not merely a placeholder one — so
     * "seeded users cannot log in" was true twice over, and adding a real hash to the admin alone
     * would have left the agents unable to sign in for a different reason. Both halves are fixed here
     * or neither is.
     *
     * Ids stay deterministic (`seed-cred-<user id>`) so the runner's upsert is idempotent and a second
     * seed run does not accumulate credentials.
     */
    credentials: devPasswordHash
      ? [
          {
            id: SEED_CREDENTIAL_ID,
            account_id: SEED_ACCOUNT_ID,
            user_id: SEED_AUTH_USER_ID,
            type: 'password',
            secret_hash: devPasswordHash,
          },
          ...SEED_ROUTING_USER_IDS.map((user_id) => ({
            id: `seed-cred-${user_id}`,
            account_id: SEED_ACCOUNT_ID,
            user_id,
            type: 'password',
            secret_hash: devPasswordHash,
          })),
        ]
      : [
          {
            id: SEED_CREDENTIAL_ID,
            account_id: SEED_ACCOUNT_ID,
            user_id: SEED_AUTH_USER_ID,
            type: 'password',
            secret_hash: SEED_PLACEHOLDER_SECRET, // labelled placeholder — NOT a real secret
          },
        ],
    userRoles: [
      { user_id: SEED_AUTH_USER_ID, role_id: SEED_ROLE_ID },
      ...SEED_ROUTING_USER_IDS.map((user_id) => ({
        user_id,
        role_id: roleId('support_agent'),
      })),
    ],

    /**
     * Feature 024 (roadmap 5.3) — two groups, and NOT ONE PERMISSION GRANT between them.
     *
     * ⚠️ **The absence is the shipped configuration, not an oversight.** The operator has said, twice
     * and separately, that all support agents work on all topics and that groups start out shared. So
     * the CAPABILITY to restrict ships and at go-live nothing restricts (ADR 0039 §7) — and
     * `seed.groups.spec.ts` proves it by comparing effective permission sets with and without the
     * memberships, which is a claim that cannot pass vacuously the way "no grants appear in this file"
     * can.
     *
     * The names are placeholder labels. Nothing in the product may branch on one (§9), which is why
     * they are neutral rather than the operation's real desk names.
     */
    groups: [
      /**
       * ⭐ Feature 031 (roadmap 4.20): `routable` — whether the router PUSHES work to this desk. It
       * defaults to **false** in the schema, deliberately, so a deployment that has not decided stays
       * quiet instead of routing to desks nobody meant.
       *
       * Desk A is marked routable here for the same reason `SEED_PRESENCE_ONLINE_USER_IDS` exists: the
       * demo desk has to be able to receive work or the seeded database is not usable, and feature 024's
       * live assertions would go red for a CORRECT reason. And like that constant, it is an explicit
       * STATEMENT ("this demo desk is a queue"), never a default — desk B stays not routable, which also
       * gives the stand a fixture for the refusal.
       */
      {
        id: SEED_GROUP_A_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'Seed Desk A',
        active: true,
        routable: true,
      },
      {
        id: SEED_GROUP_B_ID,
        account_id: SEED_ACCOUNT_ID,
        name: 'Seed Desk B',
        active: true,
        routable: false,
      },
    ],
    // Three members on desk A so a rotation has something to rotate over, and one of them also on
    // desk B so multiple membership (ADR 0039 §Open item 4) is exercised by the seeded data itself.
    groupMembers: [
      ...SEED_ROUTING_USER_IDS.map((user_id) => ({ group_id: SEED_GROUP_A_ID, user_id })),
      { group_id: SEED_GROUP_B_ID, user_id: SEED_ROUTING_USER_IDS[0]! },
    ],
    /** Deliberately EMPTY. See the note on `groups` above. */
    groupPermissions: [] as { group_id: string; permission_id: string }[],
  };
}

export type AuthSeed = ReturnType<typeof buildSeed>;
