import type { AuthConfig } from '../config';

/**
 * Set-time password policy (feature 010, analyze U1). A pure, config-driven validator applied at
 * EVERY password-set surface (super-admin activation + invited-user registration) BEFORE any
 * credential/user write. Feature 009 intentionally shipped no password-set surface; this is it.
 *
 * Never logs or echoes the password (Principle IV) — it returns only machine reasons.
 */
export interface PasswordPolicy {
  minLength: number;
  requireUppercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
}

/** Machine-readable failure reasons (safe to surface; never include the password itself). */
export type PasswordFailure = 'min_length' | 'uppercase' | 'digit' | 'symbol';

export interface PasswordPolicyResult {
  ok: boolean;
  failures: PasswordFailure[];
}

/** Derive the active policy from the validated auth config. */
export function policyFromConfig(cfg: AuthConfig): PasswordPolicy {
  return {
    minLength: cfg.PASSWORD_MIN_LENGTH,
    requireUppercase: cfg.PASSWORD_REQUIRE_UPPERCASE,
    requireDigit: cfg.PASSWORD_REQUIRE_DIGIT,
    requireSymbol: cfg.PASSWORD_REQUIRE_SYMBOL,
  };
}

/** Validate a candidate password against the policy. Pure; no I/O, no logging. */
export function validatePassword(password: string, policy: PasswordPolicy): PasswordPolicyResult {
  const failures: PasswordFailure[] = [];
  if (password.length < policy.minLength) failures.push('min_length');
  if (policy.requireUppercase && !/[A-Z]/.test(password)) failures.push('uppercase');
  if (policy.requireDigit && !/[0-9]/.test(password)) failures.push('digit');
  // A "symbol" is any character that is not a letter or digit (whitespace counts as a symbol).
  if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) failures.push('symbol');
  return { ok: failures.length === 0, failures };
}
