import { validatePassword, policyFromConfig, type PasswordPolicy } from './password-policy';
import { makeAuthConfig } from '../../tests/support/auth-test-doubles';

/**
 * T006 (feature 010) — set-time password policy (analyze U1). FAILS before the validator exists.
 * Default policy: ≥6 chars + ≥1 uppercase + ≥1 digit + ≥1 symbol.
 */
describe('password policy', () => {
  const policy: PasswordPolicy = policyFromConfig(makeAuthConfig());

  it('accepts a compliant password', () => {
    expect(validatePassword('Passw0rd!', policy)).toEqual({ ok: true, failures: [] });
  });

  it('rejects a too-short password', () => {
    const r = validatePassword('Ab1!', policy);
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('min_length');
  });

  it('rejects a password with no uppercase', () => {
    const r = validatePassword('passw0rd!', policy);
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('uppercase');
  });

  it('rejects a password with no digit', () => {
    const r = validatePassword('Password!', policy);
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('digit');
  });

  it('rejects a password with no symbol', () => {
    const r = validatePassword('Passw0rd', policy);
    expect(r.ok).toBe(false);
    expect(r.failures).toContain('symbol');
  });

  it('reports every violated rule at once', () => {
    const r = validatePassword('abc', policy);
    expect(r.ok).toBe(false);
    expect(new Set(r.failures)).toEqual(new Set(['min_length', 'uppercase', 'digit', 'symbol']));
  });

  it('honors relaxed config (only min length)', () => {
    const relaxed = policyFromConfig(
      makeAuthConfig({
        PASSWORD_REQUIRE_UPPERCASE: false,
        PASSWORD_REQUIRE_DIGIT: false,
        PASSWORD_REQUIRE_SYMBOL: false,
      }),
    );
    expect(validatePassword('abcdef', relaxed).ok).toBe(true);
    expect(validatePassword('abc', relaxed).failures).toEqual(['min_length']);
  });

  it('never echoes the password in its result', () => {
    const secret = 'MyS3cret!';
    const r = validatePassword(secret, policy);
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});
