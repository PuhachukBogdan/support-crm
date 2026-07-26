/**
 * Track-A test doubles for the auth engine (feature 009): a stateful in-memory Prisma stand-in
 * and a fast AuthConfig factory. No Docker, no real DB — the services are exercised against
 * these fakes plus the in-memory EmailPort and a FixedClock (research R8).
 */
import type { AuthConfig } from '../../src/config';

/** Fast argon2 cost for tests (real cost is config-driven in production). */
export function makeAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    NODE_ENV: 'test',
    GRPC_URL: '0.0.0.0:50051',
    DATABASE_URL: 'postgresql://test',
    JWT_SECRET: 'test-secret-0123456789-abcdefghij-KLMNOP',
    ACCESS_TTL: 900,
    SESSION_TTL: 86_400,
    REMEMBER_TTL: 604_800,
    CODE_TTL: 600,
    CODE_LENGTH: 6,
    CODE_MAX_ATTEMPTS: 5,
    LOCKOUT_THRESHOLD: 5,
    LOCKOUT_WINDOW: 900,
    ARGON2_MEMORY_COST: 1024,
    ARGON2_TIME_COST: 1,
    PASSWORD_MIN_LENGTH: 6,
    PASSWORD_REQUIRE_UPPERCASE: true,
    PASSWORD_REQUIRE_DIGIT: true,
    PASSWORD_REQUIRE_SYMBOL: true,
    INVITE_TTL: 86_400,
    INVITE_RATE_MAX: 20,
    INVITE_RATE_WINDOW: 3_600,
    ONBOARD_REQUEST_RATE_MAX: 5,
    ONBOARD_REQUEST_RATE_WINDOW: 900,
    ...overrides,
  } as AuthConfig;
}

export interface FakeUser {
  id: string;
  account_id: string;
  email: string;
  display_name?: string | null;
  status: string;
  failed_login_count: number;
  locked_until: Date | null;
}
export interface FakeCredential {
  id: string;
  account_id: string;
  user_id: string;
  type: string;
  secret_hash: string | null;
}
export interface FakeLoginCode {
  id: string;
  account_id: string;
  user_id: string;
  challenge_id: string;
  code_hash: string;
  purpose: string;
  expires_at: Date;
  attempts: number;
  consumed_at: Date | null;
  created_at: Date;
}
export interface FakeRefreshToken {
  id: string;
  account_id: string;
  user_id: string;
  token_hash: string;
  remember_me: boolean;
  expires_at: Date;
  rotated_from: string | null;
  revoked_at: Date | null;
  created_at: Date;
}

export interface FakeWhitelistEntry {
  id: string;
  account_id: string;
  email: string;
  note: string | null;
  created_at: Date;
}
export interface FakeInvitation {
  id: string;
  account_id: string;
  email: string;
  role_key: string;
  invited_by: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

// Feature 011 (RBAC) fixtures.
export interface FakePermission {
  id: string;
  account_id: string;
  category: string;
  key: string;
  label: string | null;
  introduced_version: number;
}
export interface FakeUserPermissionSet {
  user_id: string;
  account_id: string;
  mode: string; // inherited | standalone
  snapshot_role_id: string | null;
}
export interface FakePrivilegeAudit {
  id: string;
  account_id: string;
  actor_user_id: string;
  action: string;
  target_ref: string;
  detail_json: unknown;
  created_at: Date;
}

export interface FakeSeed {
  users?: Partial<FakeUser>[];
  credentials?: Partial<FakeCredential>[];
  userRoles?: { user_id: string; roleKey: string }[];
  whitelist?: Partial<FakeWhitelistEntry>[];
  invitations?: Partial<FakeInvitation>[];
  // Feature 011 (RBAC). Roles are addressed by key; a role's fake id is `role-<key>` and a
  // permission's fake id is `perm-<key>` so fixtures stay readable.
  permissions?: { key: string; category?: string; account_id?: string; label?: string }[];
  rolePermissions?: { roleKey: string; permKey: string }[];
  // Roles addressable by key (fake id = `role-<key>`); also auto-derived from userRoles/rolePermissions.
  roles?: { key: string }[];
  userPermissionSets?: {
    user_id: string;
    mode?: string;
    account_id?: string;
    snapshot_role_id?: string | null;
  }[];
  userPermissionEntries?: { user_id: string; permKey: string; granted?: boolean }[];
}

/** A minimal, stateful stand-in for the auth PrismaService (only the methods the services use). */
export function makeFakePrisma(seed: FakeSeed = {}) {
  const users: FakeUser[] = (seed.users ?? []).map((u, i) => ({
    id: u.id ?? `user-${i + 1}`,
    account_id: u.account_id ?? 'acct-1',
    email: u.email ?? `user${i + 1}@example.test`,
    display_name: u.display_name ?? null,
    status: u.status ?? 'active',
    failed_login_count: u.failed_login_count ?? 0,
    locked_until: u.locked_until ?? null,
  }));
  const credentials: FakeCredential[] = (seed.credentials ?? []).map((c, i) => ({
    id: c.id ?? `cred-${i + 1}`,
    account_id: c.account_id ?? 'acct-1',
    user_id: c.user_id ?? 'user-1',
    type: c.type ?? 'password',
    secret_hash: c.secret_hash ?? null,
  }));
  const loginCodes: FakeLoginCode[] = [];
  const refreshTokens: FakeRefreshToken[] = [];
  const userRoles: { user_id: string; roleKey: string }[] = seed.userRoles ?? [];
  const roles: { id: string; account_id: string; key: string }[] = [];
  const whitelist: FakeWhitelistEntry[] = (seed.whitelist ?? []).map((w, i) => ({
    id: w.id ?? `wl-${i + 1}`,
    account_id: w.account_id ?? 'acct-1',
    email: w.email ?? `sa${i + 1}@example.test`,
    note: w.note ?? null,
    created_at: w.created_at ?? new Date(),
  }));
  const invitations: FakeInvitation[] = (seed.invitations ?? []).map((v, i) => ({
    id: v.id ?? `inv-${i + 1}`,
    account_id: v.account_id ?? 'acct-1',
    email: v.email ?? `invitee${i + 1}@example.test`,
    role_key: v.role_key ?? 'manager',
    invited_by: v.invited_by ?? 'user-1',
    token_hash: v.token_hash ?? '',
    expires_at: v.expires_at ?? new Date(Date.now() + 86_400_000),
    consumed_at: v.consumed_at ?? null,
    created_at: v.created_at ?? new Date(),
  }));
  // Feature 011 (RBAC) fixture tables.
  const permissions: FakePermission[] = (seed.permissions ?? []).map((p) => ({
    id: `perm-${p.key}`,
    account_id: p.account_id ?? 'acct-1',
    category: p.category ?? 'crm',
    key: p.key,
    label: p.label ?? null,
    introduced_version: 1,
  }));
  const rolePermissions: { role_id: string; permission_id: string }[] = (
    seed.rolePermissions ?? []
  ).map((rp) => ({ role_id: `role-${rp.roleKey}`, permission_id: `perm-${rp.permKey}` }));
  const userPermissionSets: FakeUserPermissionSet[] = (seed.userPermissionSets ?? []).map((s) => ({
    user_id: s.user_id,
    account_id: s.account_id ?? 'acct-1',
    mode: s.mode ?? 'inherited',
    snapshot_role_id: s.snapshot_role_id ?? null,
  }));
  const userPermissionEntries: { user_id: string; permission_id: string; granted: boolean }[] = (
    seed.userPermissionEntries ?? []
  ).map((e) => ({ user_id: e.user_id, permission_id: `perm-${e.permKey}`, granted: e.granted ?? true }));
  const privilegeAudits: FakePrivilegeAudit[] = [];

  // Roles addressable by key (fake id convention: `role-<key>`) — union of every place a role key
  // appears, so services can resolve/assign roles hermetically. role.findFirst returns null for keys
  // never seeded (so not-found is testable).
  for (const key of new Set<string>([
    ...(seed.roles ?? []).map((r) => r.key),
    ...userRoles.map((ur) => ur.roleKey),
    ...(seed.rolePermissions ?? []).map((rp) => rp.roleKey),
  ])) {
    roles.push({ id: `role-${key}`, account_id: 'acct-1', key });
  }

  let lc = 0;
  let rt = 0;
  let uc = users.length;
  let cc = credentials.length;
  let ic = invitations.length;

  const prisma = {
    user: {
      findFirst: async ({ where }: { where: { email?: string; id?: string } }) =>
        users.find((u) => (where.email ? u.email === where.email : u.id === where.id)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        users.find((u) => u.id === where.id) ?? null,
      create: async ({ data }: { data: Partial<FakeUser> }) => {
        const row: FakeUser = {
          id: data.id ?? `user-${++uc}`,
          account_id: data.account_id ?? 'acct-1',
          email: data.email ?? `user${uc}@example.test`,
          display_name: data.display_name ?? null,
          status: data.status ?? 'active',
          failed_login_count: data.failed_login_count ?? 0,
          locked_until: data.locked_until ?? null,
        };
        users.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeUser> }) => {
        const u = users.find((x) => x.id === where.id)!;
        Object.assign(u, data);
        return u;
      },
    },
    credential: {
      findFirst: async ({ where }: { where: { user_id: string; type: string } }) =>
        credentials.find((c) => c.user_id === where.user_id && c.type === where.type) ?? null,
      create: async ({ data }: { data: Partial<FakeCredential> }) => {
        const row: FakeCredential = {
          id: data.id ?? `cred-${++cc}`,
          account_id: data.account_id ?? 'acct-1',
          user_id: data.user_id ?? 'user-1',
          type: data.type ?? 'password',
          secret_hash: data.secret_hash ?? null,
        };
        credentials.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeCredential>;
      }) => {
        const c = credentials.find((x) => x.id === where.id)!;
        Object.assign(c, data);
        return c;
      },
    },
    loginCode: {
      create: async ({ data }: { data: Omit<FakeLoginCode, 'id' | 'attempts' | 'consumed_at' | 'created_at'> }) => {
        const row: FakeLoginCode = {
          id: `lc-${++lc}`,
          attempts: 0,
          consumed_at: null,
          created_at: new Date(),
          ...data,
        };
        loginCodes.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { challenge_id: string } }) =>
        loginCodes.find((r) => r.challenge_id === where.challenge_id) ?? null,
      findFirst: async ({
        where,
      }: {
        where: { user_id: string; purpose: string; consumed_at: null };
      }) =>
        loginCodes
          .filter(
            (r) =>
              r.user_id === where.user_id &&
              r.purpose === where.purpose &&
              r.consumed_at === null,
          )
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0] ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeLoginCode> }) => {
        const r = loginCodes.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { user_id: string; consumed_at: null };
        data: Partial<FakeLoginCode>;
      }) => {
        let count = 0;
        for (const r of loginCodes) {
          if (r.user_id === where.user_id && r.consumed_at === null) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      },
    },
    refreshToken: {
      create: async ({ data }: { data: Omit<FakeRefreshToken, 'id' | 'revoked_at' | 'created_at'> }) => {
        const row: FakeRefreshToken = {
          id: `rt-${++rt}`,
          revoked_at: null,
          created_at: new Date(),
          ...data,
        };
        refreshTokens.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        refreshTokens.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeRefreshToken> }) => {
        const r = refreshTokens.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { user_id: string; revoked_at: null };
        data: Partial<FakeRefreshToken>;
      }) => {
        let count = 0;
        for (const r of refreshTokens) {
          if (r.user_id === where.user_id && r.revoked_at === null) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      },
    },
    role: {
      // Resolve-or-create a Role by (account_id, key). Returns { id, account_id, key }.
      upsert: async ({
        where,
        create,
      }: {
        where: { account_id_key: { account_id: string; key: string } };
        create: { account_id: string; key: string };
      }) => {
        const { account_id, key } = where.account_id_key;
        let r = roles.find((x) => x.account_id === account_id && x.key === key);
        if (!r) {
          r = { id: `role-${key}`, account_id: create.account_id, key: create.key };
          roles.push(r);
        }
        return r;
      },
      findFirst: async ({ where }: { where: { key?: string; id?: string } }) =>
        roles.find((r) => (where.key !== undefined ? r.key === where.key : r.id === where.id)) ?? null,
      findUnique: async ({
        where,
      }: {
        where: { id?: string; account_id_key?: { account_id: string; key: string } };
      }) => {
        // Match real Prisma: findUnique accepts either the id or the @@unique([account_id, key]).
        if (where.account_id_key) {
          const { account_id, key } = where.account_id_key;
          return roles.find((r) => r.account_id === account_id && r.key === key) ?? null;
        }
        return roles.find((r) => r.id === where.id) ?? null;
      },
    },
    userRole: {
      findMany: async ({ where }: { where?: { user_id?: string; role_id?: string } } = {}) =>
        userRoles
          .filter(
            (ur) =>
              (where?.user_id === undefined || ur.user_id === where.user_id) &&
              (where?.role_id === undefined || `role-${ur.roleKey}` === where.role_id),
          )
          .map((ur) => ({
            user_id: ur.user_id,
            role_id: `role-${ur.roleKey}`,
            role: { id: `role-${ur.roleKey}`, key: ur.roleKey },
          })),
      create: async ({ data }: { data: { user_id: string; role_id: string } }) => {
        const r = roles.find((x) => x.id === data.role_id);
        const roleKey = r?.key ?? data.role_id.replace(/^role-/, '');
        userRoles.push({ user_id: data.user_id, roleKey });
        return { user_id: data.user_id, role_id: data.role_id };
      },
      deleteMany: async ({ where }: { where: { user_id?: string; role_id?: string } }) => {
        const before = userRoles.length;
        for (let i = userRoles.length - 1; i >= 0; i--) {
          const ur = userRoles[i]!;
          if (
            (where.user_id === undefined || ur.user_id === where.user_id) &&
            (where.role_id === undefined || `role-${ur.roleKey}` === where.role_id)
          )
            userRoles.splice(i, 1);
        }
        return { count: before - userRoles.length };
      },
    },
    superadminWhitelist: {
      findUnique: async ({ where }: { where: { email: string } }) =>
        whitelist.find((w) => w.email === where.email) ?? null,
      findFirst: async ({ where }: { where: { email: string } }) =>
        whitelist.find((w) => w.email === where.email) ?? null,
    },
    invitation: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        invitations.find((v) => v.id === where.id) ?? null,
      create: async ({ data }: { data: Omit<FakeInvitation, 'id' | 'consumed_at' | 'created_at'> }) => {
        const row: FakeInvitation = {
          id: `inv-${++ic}`,
          consumed_at: null,
          created_at: new Date(),
          ...data,
        };
        invitations.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeInvitation> }) => {
        const v = invitations.find((x) => x.id === where.id)!;
        Object.assign(v, data);
        return v;
      },
    },
    // --- Feature 011 (RBAC) ---
    permission: {
      findFirst: async ({ where }: { where: { key?: string; id?: string } }) =>
        permissions.find((p) => (where.key !== undefined ? p.key === where.key : p.id === where.id)) ??
        null,
      findMany: async ({
        where,
      }: { where?: { id?: { in: string[] }; key?: { in: string[] } } } = {}) => {
        if (where?.id?.in) return permissions.filter((p) => where.id!.in.includes(p.id));
        if (where?.key?.in) return permissions.filter((p) => where.key!.in.includes(p.key));
        return permissions;
      },
    },
    rolePermission: {
      findMany: async ({ where }: { where?: { role_id?: string } } = {}) =>
        rolePermissions.filter((rp) => !where?.role_id || rp.role_id === where.role_id),
      upsert: async ({
        where,
        create,
      }: {
        where: { role_id_permission_id: { role_id: string; permission_id: string } };
        create: { role_id: string; permission_id: string };
      }) => {
        const k = where.role_id_permission_id;
        if (
          !rolePermissions.some(
            (rp) => rp.role_id === k.role_id && rp.permission_id === k.permission_id,
          )
        )
          rolePermissions.push({ role_id: create.role_id, permission_id: create.permission_id });
        return { role_id: k.role_id, permission_id: k.permission_id };
      },
      create: async ({ data }: { data: { role_id: string; permission_id: string } }) => {
        rolePermissions.push({ role_id: data.role_id, permission_id: data.permission_id });
        return data;
      },
      deleteMany: async ({ where }: { where: { role_id?: string; permission_id?: string } }) => {
        const before = rolePermissions.length;
        for (let i = rolePermissions.length - 1; i >= 0; i--) {
          const rp = rolePermissions[i]!;
          if (
            (where.role_id === undefined || rp.role_id === where.role_id) &&
            (where.permission_id === undefined || rp.permission_id === where.permission_id)
          )
            rolePermissions.splice(i, 1);
        }
        return { count: before - rolePermissions.length };
      },
    },
    userPermissionSet: {
      findUnique: async ({ where }: { where: { user_id: string } }) =>
        userPermissionSets.find((s) => s.user_id === where.user_id) ?? null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { user_id: string };
        create: FakeUserPermissionSet;
        update: Partial<FakeUserPermissionSet>;
      }) => {
        const existing = userPermissionSets.find((s) => s.user_id === where.user_id);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: FakeUserPermissionSet = {
          user_id: create.user_id,
          account_id: create.account_id ?? 'acct-1',
          mode: create.mode ?? 'inherited',
          snapshot_role_id: create.snapshot_role_id ?? null,
        };
        userPermissionSets.push(row);
        return row;
      },
    },
    userPermissionEntry: {
      findMany: async ({ where }: { where: { user_id: string; granted?: boolean } }) =>
        userPermissionEntries.filter(
          (e) =>
            e.user_id === where.user_id &&
            (where.granted === undefined || e.granted === where.granted),
        ),
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { user_id_permission_id: { user_id: string; permission_id: string } };
        create: { user_id: string; permission_id: string; granted?: boolean };
        update: { granted?: boolean };
      }) => {
        const k = where.user_id_permission_id;
        const existing = userPermissionEntries.find(
          (e) => e.user_id === k.user_id && e.permission_id === k.permission_id,
        );
        if (existing) {
          if (update.granted !== undefined) existing.granted = update.granted;
          return existing;
        }
        const row = {
          user_id: create.user_id,
          permission_id: create.permission_id,
          granted: create.granted ?? true,
        };
        userPermissionEntries.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: { user_id?: string; permission_id?: string } }) => {
        const before = userPermissionEntries.length;
        for (let i = userPermissionEntries.length - 1; i >= 0; i--) {
          const e = userPermissionEntries[i]!;
          if (
            (where.user_id === undefined || e.user_id === where.user_id) &&
            (where.permission_id === undefined || e.permission_id === where.permission_id)
          )
            userPermissionEntries.splice(i, 1);
        }
        return { count: before - userPermissionEntries.length };
      },
    },
    privilegeAudit: {
      create: async ({ data }: { data: Omit<FakePrivilegeAudit, 'id' | 'created_at'> }) => {
        const row: FakePrivilegeAudit = {
          id: `pa-${privilegeAudits.length + 1}`,
          created_at: new Date(),
          ...data,
        };
        privilegeAudits.push(row);
        return row;
      },
    },
    // The account-scoped client (feature 007) — in tests the fake IS already single-account, so
    // `forAccount` just returns itself (the resolver calls `prisma.forAccount(accountId).<model>`).
    forAccount: () => prisma,
    // Expose the backing arrays for assertions.
    _tables: {
      users,
      credentials,
      loginCodes,
      refreshTokens,
      roles,
      userRoles,
      whitelist,
      invitations,
      permissions,
      rolePermissions,
      userPermissionSets,
      userPermissionEntries,
      privilegeAudits,
    },
  };
  return prisma;
}

export type FakePrisma = ReturnType<typeof makeFakePrisma>;
