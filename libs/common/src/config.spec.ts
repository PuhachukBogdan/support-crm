import { z } from 'zod';
import { loadConfig, ConfigError } from './config';

// US2 / SEC-6 / FR-004, FR-013: services must refuse to start on missing or placeholder
// config, naming all offending KEYS and never leaking a value. Compose-independent.

const shape = {
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  GRPC_URL: z.string().min(1),
  GATEWAY_PORT: z.coerce.number().int().positive(),
};

const valid: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgresql://svc_user:s3cr3t@localhost:5432/svc',
  REDIS_URL: 'redis://localhost:6379',
  GRPC_URL: 'localhost:50051',
  GATEWAY_PORT: '3000',
};

describe('loadConfig (refuse-to-start, SEC-6)', () => {
  it('returns typed, coerced config on the happy path', () => {
    const cfg = loadConfig(shape, valid);
    expect(cfg.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(cfg.GATEWAY_PORT).toBe(3000); // coerced number, not string
  });

  it('throws naming a missing required key', () => {
    const env: NodeJS.ProcessEnv = { ...valid };
    delete env.REDIS_URL;
    expect(() => loadConfig(shape, env)).toThrow(ConfigError);
    try {
      loadConfig(shape, env);
    } catch (e) {
      expect((e as ConfigError).keys).toEqual(['REDIS_URL']);
    }
  });

  it('treats a known placeholder as missing (placeholders are not real secrets)', () => {
    const env: NodeJS.ProcessEnv = { ...valid, DATABASE_URL: 'CHANGE_ME' };
    try {
      loadConfig(shape, env);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).keys).toContain('DATABASE_URL');
    }
  });

  it('treats a blank / whitespace value as missing', () => {
    const env: NodeJS.ProcessEnv = { ...valid, GRPC_URL: '   ' };
    expect(() => loadConfig(shape, env)).toThrow(ConfigError);
  });

  it('reports ALL offending keys (partial secrets), sorted', () => {
    const env: NodeJS.ProcessEnv = { ...valid };
    delete env.DATABASE_URL;
    env.GRPC_URL = 'changeme';
    try {
      loadConfig(shape, env);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as ConfigError).keys).toEqual(['DATABASE_URL', 'GRPC_URL']);
    }
  });

  it('never leaks a secret VALUE in the error message (only key names)', () => {
    const env: NodeJS.ProcessEnv = { ...valid, DATABASE_URL: 'changeme' };
    // A real, sensitive value present on another key must not appear in the message.
    env.REDIS_URL = 'redis://:SuperSecretRedisPass@localhost:6379';
    // But REDIS_URL is valid, so only DATABASE_URL offends:
    try {
      loadConfig(shape, env);
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as ConfigError).message;
      expect(msg).toContain('DATABASE_URL');
      expect(msg).not.toContain('SuperSecretRedisPass');
    }
  });
});
