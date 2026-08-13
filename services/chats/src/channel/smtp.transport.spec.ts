import { resolveChannelSmtpConfig } from './smtp.transport';

/**
 * Where the channel's replies go (feature 033, FR-041/FR-042).
 *
 * ── The defect these cover ──────────────────────────────────────────────────────────────────────
 * `chats` (the agent's reply) and `auth` (a login code) both read `MAIL_HOST`, and compose hands both
 * blocks the one value — so a deployment could not point them at different relays. `compose.yaml`'s own
 * `greenmail` block states the split it needed all along (*"it holds no login codes — those stay in
 * mailpit"*), and `live-w3.sh` reads the agent's reply out of greenmail over IMAP while reading codes out
 * of mailpit over REST. Whichever leg lost, the round would have failed and blamed the product.
 *
 * ⚠️ FOUND BY PREPARING A LIVE RUN, not by the 4 194 tests that were green: every unit test hands the
 * transport a fake `sendMail`, and a fake needs no address. The address is exactly the part a fake erases.
 */
describe('resolveChannelSmtpConfig — the channel relay is addressable on its own', () => {
  /** The existing contract: with no channel-specific key, behaviour is byte-for-byte what it was. */
  it('falls back to MAIL_* when the channel names no relay of its own', () => {
    const cfg = resolveChannelSmtpConfig({
      MAIL_HOST: 'mailpit',
      MAIL_PORT: '1025',
      MAIL_SECURE: 'false',
      MAIL_USER: 'shared-user',
      MAIL_PASSWORD: 'shared-pw',
    });
    expect(cfg).toMatchObject({
      host: 'mailpit',
      port: 1025,
      secure: false,
      user: 'shared-user',
      password: 'shared-pw',
    });
  });

  it('sends through the channel relay when one is named, alongside a different auth relay', () => {
    const cfg = resolveChannelSmtpConfig({
      MAIL_HOST: 'mailpit', // auth's relay, in the same .env, deliberately unchanged
      MAIL_PORT: '1025',
      CHANNEL_SMTP_HOST: 'greenmail',
      CHANNEL_SMTP_PORT: '3025',
    });
    expect(cfg.host).toBe('greenmail');
    expect(cfg.port).toBe(3025);
  });

  /**
   * ⭐ The security property, and the reason the seam is the HOST rather than each key.
   *
   * A per-key fallback would hand the transactional relay's credentials to a different company's server
   * the first time somebody set the host and forgot the user — a credential disclosure produced by a
   * convenience. So naming a channel relay means configuring it.
   */
  it('never carries MAIL_* credentials over to a different host', () => {
    const cfg = resolveChannelSmtpConfig({
      MAIL_HOST: 'relay.transactional.example',
      MAIL_USER: 'apikey',
      MAIL_PASSWORD: 'the-transactional-secret',
      CHANNEL_SMTP_HOST: 'imap.provider.example',
    });
    expect(cfg.host).toBe('imap.provider.example');
    expect(cfg.user).toBeUndefined();
    expect(cfg.password).toBe('');
  });

  it('assumes submission (587), not the catcher, when a relay of its own is named without a port', () => {
    expect(resolveChannelSmtpConfig({ CHANNEL_SMTP_HOST: 'smtp.provider.example' }).port).toBe(587);
  });

  /** One boundary, one list — a deployment with two relays names both hosts in the single allow-list. */
  it('reads the ONE egress allow-list, which does not split with the host', () => {
    const cfg = resolveChannelSmtpConfig({
      CHANNEL_SMTP_HOST: 'greenmail',
      MAIL_ALLOWED_HOSTS: 'mailpit, GreenMail:3025',
    });
    expect(cfg.allowedHosts).toEqual(['mailpit', 'greenmail']);
  });

  /** White-label rule 6: the channel's own address is the fallback `from`, and it beats MAIL_FROM. */
  it('prefers the channel address over MAIL_FROM as the fallback sender', () => {
    expect(
      resolveChannelSmtpConfig({
        CHANNEL_EMAIL_ADDRESS: 'support-brand1@stand.test',
        MAIL_FROM: 'no-reply@localhost',
      }).from,
    ).toBe('support-brand1@stand.test');
  });
});
