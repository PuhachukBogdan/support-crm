import { JwtService } from '@nestjs/jwt';
import { RefreshService } from './refresh.service';
import { TokenService } from './token.service';
import type { PrismaService } from '../prisma.service';
import { FixedClock } from './ports/clock';
import { makeAuthConfig, makeFakePrisma, type FakePrisma } from '../../tests/support/auth-test-doubles';

/**
 * T024 (US3) — refresh rotation + revocation. Refresh ROTATES (old token revoked, successor
 * linked); reuse of a revoked token is refused AND revokes the whole live chain (theft
 * response); the session class (1d/7d) is preserved across rotation; logout revokes.
 */
describe('RefreshService (feature 009, US3)', () => {
  const cfg = makeAuthConfig();
  let prisma: FakePrisma;
  let clock: FixedClock;
  let tokens: TokenService;
  let refresh: RefreshService;

  beforeEach(() => {
    prisma = makeFakePrisma({
      users: [{ id: 'user-1', account_id: 'acct-A', email: 'staff@example.test' }],
      userRoles: [{ user_id: 'user-1', roleKey: 'agent' }],
    });
    clock = new FixedClock();
    const p = prisma as unknown as PrismaService;
    tokens = new TokenService(cfg, clock, p, new JwtService({}));
    refresh = new RefreshService(cfg, clock, p, tokens);
  });

  async function issue(rememberMe = false) {
    return (await tokens.issueRefresh('user-1', 'acct-A', rememberMe)).refreshToken;
  }

  it('rotates: the old token is revoked and a linked successor is issued', async () => {
    const raw = await issue();
    const oldId = raw.split('.')[0]!;
    const pair = await refresh.refresh(raw);
    expect(pair).not.toBeNull();

    const oldRow = prisma._tables.refreshTokens.find((r) => r.id === oldId)!;
    expect(oldRow.revoked_at).not.toBeNull();

    const newId = pair!.refreshToken.split('.')[0]!;
    const newRow = prisma._tables.refreshTokens.find((r) => r.id === newId)!;
    expect(newRow.rotated_from).toBe(oldId);
    expect(newRow.revoked_at).toBeNull();
  });

  it('refuses reuse of an already-rotated token and revokes the whole live chain', async () => {
    const raw = await issue();
    const first = await refresh.refresh(raw); // rotates raw → newToken (live)
    expect(first).not.toBeNull();

    // Replaying the original (now revoked) token: refused + chain nuked.
    expect(await refresh.refresh(raw)).toBeNull();
    const live = prisma._tables.refreshTokens.filter((r) => r.revoked_at === null);
    expect(live).toHaveLength(0); // even the fresh successor was revoked (fail-closed)
  });

  it('preserves the "remember me" class across rotation (~7d, not downgraded)', async () => {
    const raw = await issue(true);
    const pair = await refresh.refresh(raw);
    const newRow = prisma._tables.refreshTokens.find(
      (r) => r.id === pair!.refreshToken.split('.')[0],
    )!;
    expect(newRow.remember_me).toBe(true);
    const ttlSec = Math.round((newRow.expires_at.getTime() - clock.now().getTime()) / 1000);
    expect(ttlSec).toBe(cfg.REMEMBER_TTL);
  });

  it('refuses an expired refresh token (server-side clock)', async () => {
    const raw = await issue(false);
    clock.advanceSeconds(cfg.SESSION_TTL + 1);
    expect(await refresh.refresh(raw)).toBeNull();
  });

  it('refuses a malformed / unknown refresh token', async () => {
    expect(await refresh.refresh('garbage-no-dot')).toBeNull();
    expect(await refresh.refresh('rt-999.deadbeef')).toBeNull();
  });

  it('logout revokes the token so a later refresh is refused', async () => {
    const raw = await issue();
    expect(await refresh.logout(raw)).toBe(true);
    expect(await refresh.refresh(raw)).toBeNull();
    // logging out an already-revoked token is a no-op false.
    expect(await refresh.logout(raw)).toBe(false);
  });
});
