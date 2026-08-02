import { ConfigError } from '@crm/common';
import { loadAuthConfig, parseAllowedRecipientDomains } from './config';

/**
 * T006 (feature 028) — the mail configuration gate.
 *
 * FAILS before the `MAIL_*` / `APP_BASE_URL` keys exist, PASSES after.
 *
 * ── Why three of these are refuse-to-start rather than tunables ─────────────────────────────────
 * A service that boots without a mail host answers every login perfectly and delivers nothing. The
 * person sees "we sent you a code", waits, and concludes the product is broken — while every health
 * check is green. Feature 009's live run produced the same shape once already: a required key that
 * existed in `.env` and was never handed to the container.
 *
 * ⚠️ `APP_BASE_URL` has **no default on purpose.** A guessed `http://localhost:3001` would send
 * invitations that look perfect and lead nowhere — which is exactly the defect (roadmap 8.6 / T033)
 * this feature exists to close, wearing better camouflage.
 */
const BASE = {
  NODE_ENV: 'test',
  GRPC_URL: '0.0.0.0:50051',
  DATABASE_URL: 'postgresql://auth_user:pw@postgres:5432/auth_db',
  JWT_SECRET: 'a-real-looking-secret-value',
  MAIL_HOST: 'mailpit',
  MAIL_FROM: 'no-reply@example.test',
  APP_BASE_URL: 'https://crm.example.test',
} as NodeJS.ProcessEnv;

describe('loadAuthConfig — the mail gate (feature 028)', () => {
  it('accepts a complete env and exposes the documented defaults', () => {
    const cfg = loadAuthConfig({ ...BASE });

    expect(cfg.MAIL_HOST).toBe('mailpit');
    expect(cfg.MAIL_FROM).toBe('no-reply@example.test');
    expect(cfg.APP_BASE_URL).toBe('https://crm.example.test');
    expect(cfg.MAIL_PORT).toBe(1025); // the catcher's port — the default transport (research R5)
    expect(cfg.MAIL_SECURE).toBe(false);
    expect(cfg.MAIL_MAX_ATTEMPTS).toBe(5);
    expect(cfg.MAIL_SWEEP_INTERVAL_MS).toBe(15_000);
  });

  it.each(['MAIL_HOST', 'MAIL_FROM', 'APP_BASE_URL'])(
    'refuses to start when %s is missing',
    (key) => {
      const env = { ...BASE };
      delete env[key];
      expect(() => loadAuthConfig(env)).toThrow(ConfigError);
    },
  );

  it('names the missing key and never a value', () => {
    // The error is read out of a crash log by whoever is deploying. It must say what to set, and
    // it must not say what anything currently is.
    const env = { ...BASE };
    delete env.MAIL_HOST;
    try {
      loadAuthConfig(env);
      throw new Error('expected a ConfigError');
    } catch (err) {
      expect((err as ConfigError).keys).toContain('MAIL_HOST');
      expect((err as Error).message).not.toContain(BASE.JWT_SECRET as string);
    }
  });

  it('⚠️ treats an EMPTY credential as absent, the way compose passes one', () => {
    // `${MAIL_USER:-}` reaches the container as `''`, not as "unset". Read as a value it fails a
    // min-length rule and the service refuses to boot against a catcher that needs no credentials
    // — which is exactly what happened on the first live boot.
    const cfg = loadAuthConfig({ ...BASE, MAIL_USER: '', MAIL_PASSWORD: '' });
    expect(cfg.MAIL_USER).toBeUndefined();
    expect(cfg.MAIL_PASSWORD).toBeUndefined();
  });

  it('still accepts real credentials', () => {
    const cfg = loadAuthConfig({ ...BASE, MAIL_USER: 'relay-user', MAIL_PASSWORD: 'pw' });
    expect(cfg.MAIL_USER).toBe('relay-user');
  });

  it('treats credentials as optional — a catcher needs none', () => {
    // The development transport authenticates nothing. Requiring a user and password would make
    // the default setup impossible and push everyone to invent fake ones.
    const cfg = loadAuthConfig({ ...BASE });
    expect(cfg.MAIL_USER).toBeUndefined();
    expect(cfg.MAIL_PASSWORD).toBeUndefined();
  });

  it('defaults the brand to something neutral, and never to a company name', () => {
    const cfg = loadAuthConfig({ ...BASE });
    expect(cfg.MAIL_BRAND_NAME.length).toBeGreaterThan(0);
    expect(cfg.MAIL_BRAND_NAME).not.toMatch(/beton|betonwin/i);
  });
});

describe('parseAllowedRecipientDomains', () => {
  it('parses a comma-separated list, trimmed and lower-cased', () => {
    expect(parseAllowedRecipientDomains(' Example.TEST , other.test ')).toEqual([
      'example.test',
      'other.test',
    ]);
  });

  it('an empty setting means unrestricted, not "send nothing"', () => {
    // ⚠️ The failure this prevents: an empty list read as "nothing is allowed" would silently stop
    // all mail in production, where an empty list is the legitimate configuration (FR-019).
    expect(parseAllowedRecipientDomains(undefined)).toEqual([]);
    expect(parseAllowedRecipientDomains('')).toEqual([]);
    expect(parseAllowedRecipientDomains('  ,  ')).toEqual([]);
  });

  it('accepts a domain written with a leading @', () => {
    // Somebody will write `@example.test`, because that is how an address looks.
    expect(parseAllowedRecipientDomains('@example.test')).toEqual(['example.test']);
  });
});
