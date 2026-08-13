import { loadChannelConfig, parseChannelSecrets } from '../config';

/**
 * T003 (feature 033) — the channel intake's configuration.
 * FAILS before `loadChannelConfig` / `parseChannelSecrets` exist, PASSES after.
 *
 * ── Why a parser gets a test at all ─────────────────────────────────────────────────────────────
 * Only one property here is worth machine-checking, and it is not "does it split on a comma". It is
 * **which way a malformed entry fails.** An entry whose secret parses as the empty string would
 * become a channel that verifies against `''` — and an HMAC over an empty key is something an
 * attacker can compute. Dropping the entry makes the channel unknown, so its deliveries are refused.
 *
 * That is the difference between a configuration typo costing an operator a confused ten minutes and
 * costing them an open door, which is why it is asserted rather than trusted.
 */
describe('parseChannelSecrets — feature 033', () => {
  it('reads well-formed pairs', () => {
    const m = parseChannelSecrets('key-a:secret-a,key-b:secret-b');
    expect(m.get('key-a')).toBe('secret-a');
    expect(m.get('key-b')).toBe('secret-b');
    expect(m.size).toBe(2);
  });

  it('splits on the FIRST colon so a secret may contain one', () => {
    // A base64 or URL-shaped secret contains ':'. Splitting on every colon would truncate it, and
    // every signature would then fail with nothing in any log to explain why.
    const m = parseChannelSecrets('key:a:b:c');
    expect(m.get('key')).toBe('a:b:c');
  });

  it('DROPS malformed entries instead of admitting an empty secret', () => {
    // Each of these would otherwise become a channel verifying against '' — an HMAC key anyone can
    // guess. Dropped means "unknown channel", which is refused.
    const m = parseChannelSecrets('nocolon,:only-secret,key-with-no-secret:,  :  ,good:real-secret');
    expect(m.size).toBe(1);
    expect(m.get('good')).toBe('real-secret');
    expect(m.has('nocolon')).toBe(false);
    expect(m.has('key-with-no-secret')).toBe(false);
    expect(m.has('')).toBe(false);
  });

  it('treats absent and empty configuration as "no channel can be verified"', () => {
    expect(parseChannelSecrets(undefined).size).toBe(0);
    expect(parseChannelSecrets('').size).toBe(0);
    expect(parseChannelSecrets('   ,  ,').size).toBe(0);
  });
});

describe('loadChannelConfig — feature 033', () => {
  it('boots with nothing configured, verifying nothing', () => {
    // A deployment that runs no channels must start. The safety is not the default value — it is that
    // an empty map refuses every delivery rather than accepting one.
    const cfg = loadChannelConfig({} as NodeJS.ProcessEnv);
    expect(cfg.secrets.size).toBe(0);
    expect(cfg.emailAddress).toBe('');
    expect(cfg.replayWindowSeconds).toBe(300);
  });

  it('clamps the replay window instead of crashing or becoming unbounded', () => {
    // A tuning knob must never take the service down, and must never widen the forgery window to
    // "forever" because somebody typed a word.
    expect(loadChannelConfig({ CHANNEL_INTAKE_REPLAY_WINDOW_S: 'soon' } as NodeJS.ProcessEnv).replayWindowSeconds).toBe(300);
    expect(loadChannelConfig({ CHANNEL_INTAKE_REPLAY_WINDOW_S: '0' } as NodeJS.ProcessEnv).replayWindowSeconds).toBe(5);
    expect(loadChannelConfig({ CHANNEL_INTAKE_REPLAY_WINDOW_S: '999999' } as NodeJS.ProcessEnv).replayWindowSeconds).toBe(3_600);
  });
});
