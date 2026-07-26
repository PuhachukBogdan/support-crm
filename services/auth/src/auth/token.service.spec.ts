import { JwtService } from '@nestjs/jwt';
import { TokenService } from './token.service';
import type { PrismaService } from '../prisma.service';
import { FixedClock } from './ports/clock';
import { makeAuthConfig, makeFakePrisma, type FakePrisma } from '../../tests/support/auth-test-doubles';

/**
 * T013 (US1) — the access JWT round-trips its claims, fails closed on tampering, and is
 * account-BOUND (Principle I / research R7): a token minted for account A carries account A,
 * never another account. Also proves refresh issue persists only a HASH, never the clear secret.
 */
describe('TokenService (feature 009)', () => {
  const cfg = makeAuthConfig();
  let prisma: FakePrisma;
  let svc: TokenService;

  beforeEach(() => {
    prisma = makeFakePrisma();
    svc = new TokenService(cfg, new FixedClock(), prisma as unknown as PrismaService, new JwtService({}));
  });

  it('signs an access token and verifies its claims', () => {
    const { token } = svc.signAccessToken({
      userId: 'user-1',
      accountId: 'acct-A',
      roles: ['agent'],
    });
    const claims = svc.verifyAccessToken(token);
    expect(claims.valid).toBe(true);
    expect(claims.userId).toBe('user-1');
    expect(claims.accountId).toBe('acct-A');
    expect(claims.roles).toEqual(['agent']);
    expect(claims.expiresAt).toBeGreaterThan(0);
  });

  it('fails closed on a tampered/garbage token', () => {
    const claims = svc.verifyAccessToken('not.a.jwt');
    expect(claims.valid).toBe(false);
    expect(claims.accountId).toBe('');
  });

  it('is account-bound — a token minted for A never presents as another account (Principle I)', () => {
    const { token } = svc.signAccessToken({ userId: 'u', accountId: 'acct-A', roles: [] });
    const claims = svc.verifyAccessToken(token);
    expect(claims.accountId).toBe('acct-A');
    expect(claims.accountId).not.toBe('acct-B');
  });

  it('does not accept a token signed with a different secret (isolation of the signing key)', () => {
    const foreign = new JwtService({});
    const alienToken = foreign.sign(
      { sub: 'u', account_id: 'acct-B', roles: [] },
      { secret: 'a-totally-different-secret-value-999', expiresIn: 900 },
    );
    expect(svc.verifyAccessToken(alienToken).valid).toBe(false);
  });

  it('issues a refresh token persisting only the hash, in `<id>.<secret>` form', async () => {
    const issued = await svc.issueRefresh('user-1', 'acct-A', true);
    expect(issued.refreshToken).toMatch(/^rt-\d+\.[0-9a-f]{64}$/);
    const [rowId, secret] = issued.refreshToken.split('.');
    const row = prisma._tables.refreshTokens.find((r) => r.id === rowId)!;
    expect(row).toBeDefined();
    expect(row.account_id).toBe('acct-A');
    expect(row.remember_me).toBe(true);
    // The clear secret is NEVER stored — only its argon2 hash.
    expect(row.token_hash).not.toBe(secret);
    expect(row.token_hash.startsWith('$argon2')).toBe(true);
  });
});
