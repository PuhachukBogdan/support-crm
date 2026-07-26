/**
 * AdminNotificationPort seam (feature 009, FR-019 / research R5).
 *
 * When an account locks (SEC-14), the system emits a notification so an administrator sees it.
 * This feature only FIRES the port with an **identity-only** payload; choosing or routing to a
 * specific online admin needs presence state that does not exist yet and is deferred to feature
 * 010 (analyze U2). The payload MUST NOT carry the attempted password or the one-time code
 * (Principle IV / FR-015).
 */

/** Identity-only lockout alert. No secrets (no password, no code) — only who + when. */
export interface LockoutAlert {
  event: 'account_locked';
  userId: string;
  accountId: string;
  email: string; // account identity (how an admin recognises the account) — not a secret
  lockedUntil: Date;
}

export interface AdminNotificationPort {
  notifyAccountLocked(alert: LockoutAlert): Promise<void>;
}

/** Nest DI token for the AdminNotificationPort. */
export const ADMIN_NOTIFICATION_PORT = Symbol('ADMIN_NOTIFICATION_PORT');

/**
 * Dev/test adapter: records each alert for assertions. No real delivery, no routing. The real
 * transport (websocket/email to an online admin) lands with the realtime/worker phase.
 */
export class InMemoryAdminNotificationAdapter implements AdminNotificationPort {
  readonly alerts: LockoutAlert[] = [];

  async notifyAccountLocked(alert: LockoutAlert): Promise<void> {
    this.alerts.push({ ...alert });
  }

  last(): LockoutAlert | undefined {
    return this.alerts[this.alerts.length - 1];
  }

  clear(): void {
    this.alerts.length = 0;
  }
}
