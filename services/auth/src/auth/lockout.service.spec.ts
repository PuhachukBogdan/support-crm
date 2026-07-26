import { LockoutService } from './lockout.service';
import type { PrismaService } from '../prisma.service';
import { FixedClock } from './ports/clock';
import { InMemoryAdminNotificationAdapter } from './ports/admin-notify.port';
import { makeAuthConfig, makeFakePrisma, type FakePrisma } from '../../tests/support/auth-test-doubles';

/**
 * T028 (US4) — lockout after N consecutive failures (SEC-14), an identity-only admin
 * notification on lock (FR-019/FR-015), auto-release after the window, and reset on success.
 */
describe('LockoutService (feature 009, US4)', () => {
  const cfg = makeAuthConfig();
  let prisma: FakePrisma;
  let clock: FixedClock;
  let notify: InMemoryAdminNotificationAdapter;
  let svc: LockoutService;

  const userRow = () => prisma._tables.users.find((u) => u.id === 'user-1')!;

  beforeEach(() => {
    prisma = makeFakePrisma({
      users: [{ id: 'user-1', account_id: 'acct-A', email: 'staff@example.test' }],
    });
    clock = new FixedClock();
    notify = new InMemoryAdminNotificationAdapter();
    svc = new LockoutService(cfg, clock, prisma as unknown as PrismaService, notify);
  });

  it('counts failures below the threshold without locking or notifying', async () => {
    for (let i = 0; i < cfg.LOCKOUT_THRESHOLD - 1; i++) {
      expect(await svc.recordFailure(userRow())).toBe(false);
    }
    expect(userRow().failed_login_count).toBe(cfg.LOCKOUT_THRESHOLD - 1);
    expect(userRow().locked_until).toBeNull();
    expect(notify.alerts).toHaveLength(0);
  });

  it('locks at the threshold and fires an identity-only admin notification', async () => {
    let locked = false;
    for (let i = 0; i < cfg.LOCKOUT_THRESHOLD; i++) {
      locked = await svc.recordFailure(userRow());
    }
    expect(locked).toBe(true);
    expect(userRow().locked_until).not.toBeNull();

    expect(notify.alerts).toHaveLength(1);
    const alert = notify.last()!;
    expect(alert).toMatchObject({
      event: 'account_locked',
      userId: 'user-1',
      accountId: 'acct-A',
      email: 'staff@example.test',
    });
    // No secrets in the notification (FR-019/FR-015).
    const keys = Object.keys(alert);
    expect(keys).not.toContain('password');
    expect(keys).not.toContain('code');
    expect(keys).not.toContain('secret');
  });

  it('isLocked is true within the window and false once it passes (auto-release)', async () => {
    for (let i = 0; i < cfg.LOCKOUT_THRESHOLD; i++) await svc.recordFailure(userRow());
    expect(svc.isLocked(userRow())).toBe(true);
    clock.advanceSeconds(cfg.LOCKOUT_WINDOW + 1);
    expect(svc.isLocked(userRow())).toBe(false);
  });

  it('reset clears the counter and the lock (on successful login)', async () => {
    await svc.recordFailure(userRow());
    await svc.reset('user-1');
    expect(userRow().failed_login_count).toBe(0);
    expect(userRow().locked_until).toBeNull();
  });

  it('is independent of request rate-limiting — it is pure account state', () => {
    expect(svc.isLocked({ locked_until: null })).toBe(false);
    expect(svc.isLocked({ locked_until: new Date(clock.now().getTime() + 1000) })).toBe(true);
  });
});
