import { ConfigError } from '@crm/common';
import { loadUsersConfig } from './config';

/**
 * T005 (feature 016) — users refuses to start without object-store configuration, and the refusal
 * names KEYS, never values (SEC-6 / Principle IV).
 *
 * Why this is worth a test of its own rather than trusting the shared loader: the failure mode being
 * prevented is not "a bad value slipped through", it is "the upload path booted without a store".
 * That service accepts a file, validates it, and dies at the write — after the caller has been told
 * their bytes were taken. Refusing at boot is the only honest outcome, so the requirement is that
 * these six keys are REQUIRED, which is exactly what an optional-by-accident schema would lose.
 *
 * The second assertion is the one that catches a careless future edit: a config error is logged, and
 * a loader that echoed the offending value would put a live secret in the log line.
 */
const S3_KEYS = [
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE',
] as const;

const COMPLETE: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  GRPC_URL: '0.0.0.0:50052',
  DATABASE_URL: 'postgresql://users_user:pw@postgres:5432/users_db',
  S3_ENDPOINT: 'http://minio:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'crm-uploads',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLEKEYID',
  S3_SECRET_ACCESS_KEY: 'r34l-l00king-but-synthetic-secret',
  S3_FORCE_PATH_STYLE: 'true',
  CONTACT_HASH_SALT: 'synthetic-salt-for-tests-0123456789abcdef',
};

describe('users config: the object store is a boot requirement (feature 016)', () => {
  it('a complete environment loads', () => {
    const cfg = loadUsersConfig({ ...COMPLETE });
    expect(cfg.S3_BUCKET).toBe('crm-uploads');
    expect(cfg.S3_ENDPOINT).toBe('http://minio:9000');
  });

  it.each(S3_KEYS)('refuses to start when %s is missing', (key) => {
    const env = { ...COMPLETE };
    delete env[key];
    expect(() => loadUsersConfig(env)).toThrow(ConfigError);
    try {
      loadUsersConfig(env);
    } catch (err) {
      expect((err as ConfigError).keys).toEqual([key]);
    }
  });

  it.each(S3_KEYS)('refuses to start when %s is still the .env.example placeholder', (key) => {
    const env = { ...COMPLETE, [key]: 'CHANGE_ME' };
    expect(() => loadUsersConfig(env)).toThrow(ConfigError);
  });

  it('reports EVERY missing key at once, not just the first', () => {
    const env = { ...COMPLETE };
    delete env.S3_BUCKET;
    delete env.S3_ACCESS_KEY_ID;
    try {
      loadUsersConfig(env);
      throw new Error('expected a refusal');
    } catch (err) {
      expect((err as ConfigError).keys).toEqual(['S3_ACCESS_KEY_ID', 'S3_BUCKET']);
    }
  });

  it('*** the error never contains a configured VALUE *** (SEC-6)', () => {
    // A blank secret is "missing", so the offending key is named. The live values of the keys that
    // ARE set must not travel in the message — a config error is logged, and a logged secret is a
    // leaked secret.
    const env = { ...COMPLETE, S3_BUCKET: '' };
    try {
      loadUsersConfig(env);
      throw new Error('expected a refusal');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('S3_BUCKET');
      expect(message).not.toContain(COMPLETE.S3_SECRET_ACCESS_KEY!);
      expect(message).not.toContain(COMPLETE.S3_ACCESS_KEY_ID!);
      expect(message).not.toContain(COMPLETE.DATABASE_URL!);
    }
  });
});

/**
 * T001 (feature 020) — the contact-hash salt is a boot requirement.
 *
 * Same shape of failure as the S3 block, one layer nastier: an UNSALTED hash of an email is
 * reversible by dictionary in seconds. A service that booted without a salt would build a table of
 * recoverable customer contacts, serve every request correctly, and keep every test green. There is
 * no observable symptom — which is precisely why it has to be refused at boot.
 */
describe('users config: the contact-hash salt is a boot requirement (feature 020)', () => {
  it('refuses to start when the salt is absent', () => {
    const withoutSalt: NodeJS.ProcessEnv = { ...COMPLETE };
    delete withoutSalt.CONTACT_HASH_SALT;
    expect(() => loadUsersConfig(withoutSalt)).toThrow(ConfigError);
  });

  it('refuses a salt short enough to be a placeholder', () => {
    // "salt", "changeme", "dev" — the values that get committed and then forgotten.
    expect(() => loadUsersConfig({ ...COMPLETE, CONTACT_HASH_SALT: 'salt' })).toThrow(ConfigError);
    expect(() => loadUsersConfig({ ...COMPLETE, CONTACT_HASH_SALT: 'changeme' })).toThrow(ConfigError);
  });

  it('the refusal names the KEY and never the value', () => {
    try {
      loadUsersConfig({ ...COMPLETE, CONTACT_HASH_SALT: 'too-short-secret' });
      throw new Error('expected a refusal');
    } catch (err) {
      const text = String((err as Error).message);
      expect(text).toContain('CONTACT_HASH_SALT');
      expect(text).not.toContain('too-short-secret');
    }
  });

  it('a sufficiently long salt loads', () => {
    expect(loadUsersConfig({ ...COMPLETE }).CONTACT_HASH_SALT).toHaveLength(41);
  });
});
