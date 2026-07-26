import { InMemoryAdminNotificationAdapter, type LockoutAlert } from './admin-notify.port';

/**
 * T009 (feature 009) — the AdminNotificationPort records an identity-only lockout alert and
 * carries NO secret (no password, no code — FR-019/FR-015). FAILS before the port exists.
 */
describe('InMemoryAdminNotificationAdapter', () => {
  const alert: LockoutAlert = {
    event: 'account_locked',
    userId: 'user-1',
    accountId: 'acct-1',
    email: 'agent@example.test',
    lockedUntil: new Date('2026-07-21T00:15:00.000Z'),
  };

  it('records the alert for assertions', async () => {
    const notify = new InMemoryAdminNotificationAdapter();
    await notify.notifyAccountLocked(alert);
    expect(notify.alerts).toHaveLength(1);
    expect(notify.last()).toEqual(alert);
  });

  it('payload is identity-only — never a password or code field', async () => {
    const notify = new InMemoryAdminNotificationAdapter();
    await notify.notifyAccountLocked(alert);
    const keys = Object.keys(notify.last()!);
    expect(keys).toEqual(
      expect.arrayContaining(['event', 'userId', 'accountId', 'email', 'lockedUntil']),
    );
    expect(keys).not.toContain('password');
    expect(keys).not.toContain('code');
    expect(keys).not.toContain('secret');
  });
});
