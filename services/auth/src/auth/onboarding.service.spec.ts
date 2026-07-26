import { JwtService } from '@nestjs/jwt';
import { OnboardingService } from './onboarding.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { RateLimiter } from './rate-limiter';
import { OutboxEmailAdapter } from './ports/email.port';
import type { Clock } from './ports/clock';
import { makeAuthConfig, makeFakePrisma, type FakePrisma } from '../../tests/support/auth-test-doubles';

/**
 * T011 (feature 010, US1) — super-admin whitelist onboarding. FAILS before OnboardingService exists.
 * Reuses the 009 engine (OtpService/TokenService) against Track-A fakes + fixed clock.
 */
describe('OnboardingService (super-admin whitelist onboarding)', () => {
  const NOW = new Date('2026-07-21T12:00:00.000Z');
  const clock: Clock = { now: () => NOW };
  const cfg = makeAuthConfig();

  function build(prisma: FakePrisma) {
    const email = new OutboxEmailAdapter();
    const jwt = new JwtService({});
    const tokens = new TokenService(cfg, clock, prisma as never, jwt);
    const otp = new OtpService(cfg, clock, prisma as never, email);
    const rate = new RateLimiter(clock);
    const service = new OnboardingService(cfg, clock, prisma as never, otp, tokens, rate);
    return { service, email, prisma };
  }

  it('whitelisted email → code emitted, then activation creates an active super-admin + session', async () => {
    const prisma = makeFakePrisma({ whitelist: [{ email: 'god@example.test', account_id: 'acct-1' }] });
    const { service, email } = build(prisma);

    await service.requestActivation('god@example.test');
    expect(email.outbox).toHaveLength(1);
    const code = email.last()!.code;

    const outcome = await service.completeActivation('god@example.test', code, 'Passw0rd!');
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('unreachable');
    expect(outcome.pair.accessToken).toBeTruthy();
    expect(outcome.pair.refreshToken).toBeTruthy();

    const user = prisma._tables.users.find((u) => u.email === 'god@example.test')!;
    expect(user.status).toBe('active');
    expect(user.account_id).toBe('acct-1');
    expect(prisma._tables.userRoles).toContainEqual({ user_id: user.id, roleKey: 'super_admin' });
    expect(prisma._tables.credentials.find((c) => c.user_id === user.id)?.secret_hash).toBeTruthy();
  });

  it('non-whitelisted email → NO code emitted and activation is refused', async () => {
    const prisma = makeFakePrisma({ whitelist: [{ email: 'god@example.test', account_id: 'acct-1' }] });
    const { service, email } = build(prisma);

    await service.requestActivation('stranger@example.test');
    expect(email.outbox).toHaveLength(0);

    const outcome = await service.completeActivation('stranger@example.test', '123456', 'Passw0rd!');
    expect(outcome.status).toBe('invalid');
    expect(prisma._tables.users.find((u) => u.email === 'stranger@example.test')).toBeUndefined();
  });

  it('already-active account → no code emitted, no re-provision', async () => {
    const prisma = makeFakePrisma({
      whitelist: [{ email: 'god@example.test', account_id: 'acct-1' }],
      users: [{ id: 'u1', email: 'god@example.test', account_id: 'acct-1', status: 'active' }],
    });
    const { service, email } = build(prisma);

    await service.requestActivation('god@example.test');
    expect(email.outbox).toHaveLength(0);
    const before = prisma._tables.users.length;

    const outcome = await service.completeActivation('god@example.test', '123456', 'Passw0rd!');
    expect(outcome.status).toBe('invalid');
    expect(prisma._tables.users).toHaveLength(before);
  });

  it('weak password → rejected with reasons, nothing activated', async () => {
    const prisma = makeFakePrisma({ whitelist: [{ email: 'god@example.test', account_id: 'acct-1' }] });
    const { service, email } = build(prisma);

    await service.requestActivation('god@example.test');
    const code = email.last()!.code;

    const outcome = await service.completeActivation('god@example.test', code, 'weak');
    expect(outcome.status).toBe('weak_password');
    if (outcome.status !== 'weak_password') throw new Error('unreachable');
    expect(outcome.failures.length).toBeGreaterThan(0);

    const user = prisma._tables.users.find((u) => u.email === 'god@example.test')!;
    expect(user.status).toBe('pending'); // still pending — not activated
    expect(prisma._tables.credentials.find((c) => c.user_id === user.id)?.secret_hash).toBeFalsy();
  });

  it('wrong code → activation refused, account stays pending', async () => {
    const prisma = makeFakePrisma({ whitelist: [{ email: 'god@example.test', account_id: 'acct-1' }] });
    const { service } = build(prisma);

    await service.requestActivation('god@example.test');
    const outcome = await service.completeActivation('god@example.test', 'WRONG9', 'Passw0rd!');
    expect(outcome.status).toBe('invalid');
    const user = prisma._tables.users.find((u) => u.email === 'god@example.test')!;
    expect(user.status).toBe('pending');
  });

  it('request never throws for either email class (uniform, anti-enumeration)', async () => {
    const prisma = makeFakePrisma({ whitelist: [{ email: 'god@example.test', account_id: 'acct-1' }] });
    const { service } = build(prisma);
    await expect(service.requestActivation('god@example.test')).resolves.toBeUndefined();
    await expect(service.requestActivation('stranger@example.test')).resolves.toBeUndefined();
  });
});
