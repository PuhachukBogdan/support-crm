import { Inject, Injectable } from '@nestjs/common';
import { AUTH_CONFIG, type AuthConfig } from '../config';
import { PrismaService } from '../prisma.service';
import { CLOCK, type Clock } from './ports/clock';
import { ADMIN_NOTIFICATION_PORT, type AdminNotificationPort } from './ports/admin-notify.port';

/** The subset of a User the lockout logic reads/updates. */
export interface LockoutSubject {
  id: string;
  account_id: string;
  email: string;
  failed_login_count: number;
  locked_until: Date | null;
}

/**
 * LockoutService (feature 009, US4 / T029). Contains brute force independently of any request
 * rate-limit (SEC-14): after `LOCKOUT_THRESHOLD` (5) consecutive failed sign-ins, the account
 * is locked for `LOCKOUT_WINDOW` (~15m) and an **identity-only** admin notification is fired
 * (FR-019 — no password/code; routing to a specific online admin is deferred to feature 010,
 * analyze U2). A successful login resets the counter.
 */
@Injectable()
export class LockoutService {
  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly prisma: PrismaService,
    @Inject(ADMIN_NOTIFICATION_PORT) private readonly notify: AdminNotificationPort,
  ) {}

  /** True while the account is within its lock window (evaluated server-side). */
  isLocked(subject: Pick<LockoutSubject, 'locked_until'>): boolean {
    return !!subject.locked_until && subject.locked_until.getTime() > this.clock.now().getTime();
  }

  /**
   * Record one failed sign-in. Increments the counter; at the threshold, sets `locked_until`
   * and notifies an admin (identity only). Returns whether this failure triggered the lock.
   */
  async recordFailure(subject: LockoutSubject): Promise<boolean> {
    const next = (subject.failed_login_count ?? 0) + 1;

    if (next >= this.cfg.LOCKOUT_THRESHOLD) {
      const lockedUntil = new Date(this.clock.now().getTime() + this.cfg.LOCKOUT_WINDOW * 1000);
      await this.prisma.user.update({
        where: { id: subject.id },
        data: { failed_login_count: next, locked_until: lockedUntil },
      });
      await this.notify.notifyAccountLocked({
        event: 'account_locked',
        userId: subject.id,
        accountId: subject.account_id,
        email: subject.email,
        lockedUntil,
      });
      return true;
    }

    await this.prisma.user.update({
      where: { id: subject.id },
      data: { failed_login_count: next },
    });
    return false;
  }

  /** Clear failure state after a successful login. */
  async reset(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { failed_login_count: 0, locked_until: null },
    });
  }
}
