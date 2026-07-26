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

export interface FakeSeed {
  users?: Partial<FakeUser>[];
  credentials?: Partial<FakeCredential>[];
  userRoles?: { user_id: string; roleKey: string }[];
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
  const userRoles = seed.userRoles ?? [];
  let lc = 0;
  let rt = 0;

  const prisma = {
    user: {
      findFirst: async ({ where }: { where: { email?: string; id?: string } }) =>
        users.find((u) => (where.email ? u.email === where.email : u.id === where.id)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<FakeUser> }) => {
        const u = users.find((x) => x.id === where.id)!;
        Object.assign(u, data);
        return u;
      },
    },
    credential: {
      findFirst: async ({ where }: { where: { user_id: string; type: string } }) =>
        credentials.find((c) => c.user_id === where.user_id && c.type === where.type) ?? null,
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
    userRole: {
      findMany: async ({ where }: { where: { user_id: string } }) =>
        userRoles
          .filter((ur) => ur.user_id === where.user_id)
          .map((ur) => ({ user_id: ur.user_id, role: { key: ur.roleKey } })),
    },
    // Expose the backing arrays for assertions.
    _tables: { users, credentials, loginCodes, refreshTokens },
  };
  return prisma;
}

export type FakePrisma = ReturnType<typeof makeFakePrisma>;
