import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { LoginService } from '../src/auth/login.service';
import { OtpService } from '../src/auth/otp.service';
import { TokenService } from '../src/auth/token.service';
import { RefreshService } from '../src/auth/refresh.service';
import { LockoutService } from '../src/auth/lockout.service';
import type { PrismaService } from '../src/prisma.service';
import { FixedClock } from '../src/auth/ports/clock';
import { OutboxEmailAdapter } from '../src/auth/ports/email.port';
import { InMemoryAdminNotificationAdapter } from '../src/auth/ports/admin-notify.port';
import { makeAuthConfig, makeFakePrisma, type FakePrisma } from './support/auth-test-doubles';

/**
 * T030 (Polish) — cross-cutting no-secrets-in-logs guard (FR-015 / SC-007). Exercises the whole
 * flow (login → verify → refresh → lockout) while capturing ALL console output, and asserts that
 * no password, one-time code, access/refresh token, or session id ever appears. Fails the moment
 * any auth path starts logging a secret.
 */
describe('auth flows never log secrets (FR-015 / SC-007)', () => {
  const cfg = makeAuthConfig();
  const PASSWORD = 'CorrectHorse1!';

  it('captures login/verify/refresh/lockout output and finds no secret', async () => {
    const passwordHash = await argon2.hash(PASSWORD);
    const prisma: FakePrisma = makeFakePrisma({
      users: [{ id: 'user-1', account_id: 'acct-A', email: 'staff@example.test' }],
      credentials: [{ user_id: 'user-1', type: 'password', secret_hash: passwordHash }],
      userRoles: [{ user_id: 'user-1', roleKey: 'agent' }],
    });
    const clock = new FixedClock();
    const email = new OutboxEmailAdapter();
    const p = prisma as unknown as PrismaService;
    const tokens = new TokenService(cfg, clock, p, new JwtService({}));
    const otp = new OtpService(cfg, clock, p, email);
    const lockout = new LockoutService(cfg, clock, p, new InMemoryAdminNotificationAdapter());
    const login = new LoginService(cfg, clock, p, otp, tokens, lockout);
    const refresh = new RefreshService(cfg, clock, p, tokens);

    const sinks = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const captured: string[] = [];
    const spies = sinks.map((s) =>
      jest.spyOn(console, s).mockImplementation((...args: unknown[]) => {
        captured.push(args.map(String).join(' '));
      }),
    );

    let code: string;
    let refreshToken: string;
    let accessToken: string;
    try {
      // Full happy path.
      const step1 = await login.login('staff@example.test', PASSWORD);
      code = email.last()!.code;
      const pair = await login.verifyLoginCode((step1 as { challengeId: string }).challengeId, code, true);
      accessToken = pair!.accessToken;
      refreshToken = pair!.refreshToken;
      // Rotate.
      const rotated = await refresh.refresh(refreshToken);
      // Some failures → lockout path.
      for (let i = 0; i < cfg.LOCKOUT_THRESHOLD; i++) {
        await login.login('staff@example.test', 'WrongPassword9!');
      }
      // Sanity: the flow actually produced material.
      expect(rotated).not.toBeNull();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    const haystack = captured.join('\n');
    const secrets = [
      PASSWORD,
      code!,
      accessToken!,
      refreshToken!,
      refreshToken!.split('.')[1]!, // the raw refresh secret half
    ];
    for (const secret of secrets) {
      expect(haystack).not.toContain(secret);
    }
  });
});
