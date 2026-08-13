import { parseHostAllowList } from '@crm/common';
import { loadWorkerConfig } from '../config';

/**
 * T004 (feature 033) — the outbound host allow-list, and the mailbox that may be absent.
 * FAILS before the config keys exist, PASSES after.
 *
 * ── The one thing that must be true ─────────────────────────────────────────────────────────────
 * `greenmail:3143` must match an allow-list entry of `greenmail`. Without the port strip, an operator
 * writes the value they see in `compose.yaml`, mail stops, and the reason is invisible from the value
 * they typed. This is a usability property with a security failure mode: the natural response to
 * "mail stopped and the list looks right" is to empty the list, which turns the guard off entirely.
 */
describe('parseHostAllowList — feature 033', () => {
  it('folds case and strips a port so the host still matches', () => {
    expect(parseHostAllowList('GreenMail:3143, MailPit , 127.0.0.1:1025')).toEqual([
      'greenmail',
      'mailpit',
      '127.0.0.1',
    ]);
  });

  it('treats empty as UNRESTRICTED, not as "refuse everything"', () => {
    // Deliberate, and the same reading feature 028 chose for recipient domains: reversed, an empty
    // list silently stops all mail in production, where empty is the legitimate configuration — and
    // mail that has stopped looks exactly like mail that is merely slow.
    expect(parseHostAllowList(undefined)).toEqual([]);
    expect(parseHostAllowList('  ,  ')).toEqual([]);
  });
});

const BASE = {
  NODE_ENV: 'test',
  GRPC_URL: '0.0.0.0:50055',
  REDIS_URL: 'redis://redis:6379',
  CHATS_GRPC_TARGET: 'chats:50053',
  USERS_GRPC_TARGET: 'users:50052',
  AUTH_GRPC_TARGET: 'auth:50051',
} as NodeJS.ProcessEnv;

describe('loadWorkerConfig — the channel mailbox (feature 033)', () => {
  it('boots with no mailbox configured', () => {
    // Correct for every deployment with no email channel, including the whole test suite. An absent
    // mailbox is a legitimate configuration, unlike an unreachable chats service — which is why this
    // is not a refuse-to-start key.
    const cfg = loadWorkerConfig({ ...BASE });
    expect(cfg.CHANNEL_IMAP.host).toBe('');
    expect(cfg.MAIL_ALLOWED_HOSTS).toEqual([]);
  });

  it('clamps the sweep interval, which is the safety net and not the delivery path', () => {
    // If this value ever governs how fast mail appears, the IDLE connection is broken and the sweep is
    // concealing it. Clamped so a typo cannot make it a hot loop against the mailbox.
    expect(
      loadWorkerConfig({ ...BASE, CHANNEL_MAIL_SWEEP_INTERVAL_MS: '1' }).CHANNEL_MAIL_SWEEP_INTERVAL_MS,
    ).toBe(5_000);
    expect(
      loadWorkerConfig({ ...BASE, CHANNEL_MAIL_SWEEP_INTERVAL_MS: 'often' })
        .CHANNEL_MAIL_SWEEP_INTERVAL_MS,
    ).toBe(60_000);
  });

  it('reads a configured mailbox, treating only the literal string "true" as TLS', () => {
    const cfg = loadWorkerConfig({
      ...BASE,
      CHANNEL_IMAP_HOST: 'greenmail',
      CHANNEL_IMAP_PORT: '3143',
      CHANNEL_IMAP_SECURE: 'false',
      CHANNEL_IMAP_USER: 'support@stand.test',
      CHANNEL_IMAP_PASSWORD: 'stand',
    });
    expect(cfg.CHANNEL_IMAP).toEqual({
      host: 'greenmail',
      port: 3143,
      secure: false,
      user: 'support@stand.test',
      password: 'stand',
    });
  });
});
