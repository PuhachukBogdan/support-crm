import {
  parseSchema,
  hasField,
  getField,
  columnIsIndexed,
} from '../../../../tests/data-model/schema-scan';

/**
 * T007 (feature 009) — structural proof that the auth engine's tables exist in the schema,
 * carry the tenant seam, and are indexed on their hot columns (Principle I + VII). Reads the
 * schema as TEXT (Track A, Docker-independent). FAILS before the feature-009 schema additions,
 * PASSES after.
 */
describe('auth_db schema — feature 009 additions', () => {
  const models = parseSchema('auth');
  const byName = (n: string) => models.find((m) => m.name === n);

  it('User gains lockout fields (SEC-14)', () => {
    const user = byName('User')!;
    expect(user).toBeDefined();
    expect(hasField(user, 'failed_login_count')).toBe(true);
    expect(hasField(user, 'locked_until')).toBe(true);
    // locked_until is nullable (a fresh account is not locked).
    expect(getField(user, 'locked_until')!.optional).toBe(true);
  });

  it('LoginCode exists, is account-scoped, and models the one-time code lifecycle', () => {
    const code = byName('LoginCode');
    expect(code).toBeDefined();
    for (const f of ['account_id', 'user_id', 'challenge_id', 'code_hash', 'expires_at', 'attempts', 'consumed_at']) {
      expect(hasField(code!, f)).toBe(true);
    }
    // The clear code is NEVER a column — only its hash (Principle IV).
    expect(hasField(code!, 'code')).toBe(false);
    expect(columnIsIndexed(code!, 'account_id')).toBe(true);
    expect(columnIsIndexed(code!, 'challenge_id')).toBe(true); // @unique handle
  });

  it('RefreshToken exists, is account-scoped, and models rotation/revocation', () => {
    const rt = byName('RefreshToken');
    expect(rt).toBeDefined();
    for (const f of ['account_id', 'user_id', 'token_hash', 'remember_me', 'expires_at', 'rotated_from', 'revoked_at']) {
      expect(hasField(rt!, f)).toBe(true);
    }
    // The clear refresh secret is NEVER a column — only its hash.
    expect(hasField(rt!, 'refresh_token')).toBe(false);
    expect(columnIsIndexed(rt!, 'account_id')).toBe(true);
    expect(columnIsIndexed(rt!, 'token_hash')).toBe(true);
  });
});

/**
 * T004 (feature 010) — the account-lifecycle tables exist, carry the tenant seam, and index their
 * hot columns (Principle I + VII). FAILS before the 010 schema additions.
 */
describe('auth_db schema — feature 010 additions', () => {
  const models = parseSchema('auth');
  const byName = (n: string) => models.find((m) => m.name === n);

  it('SuperadminWhitelist exists, is account-scoped, keyed by email', () => {
    const wl = byName('SuperadminWhitelist');
    expect(wl).toBeDefined();
    for (const f of ['account_id', 'email']) expect(hasField(wl!, f)).toBe(true);
    expect(columnIsIndexed(wl!, 'account_id')).toBe(true);
    // email is @unique (one authorization per address).
    expect(columnIsIndexed(wl!, 'email')).toBe(true);
  });

  it('Invitation exists, is account-scoped, and models a single-use expiring token', () => {
    const inv = byName('Invitation');
    expect(inv).toBeDefined();
    for (const f of ['account_id', 'email', 'role_key', 'invited_by', 'token_hash', 'expires_at', 'consumed_at']) {
      expect(hasField(inv!, f)).toBe(true);
    }
    // The clear invite secret is NEVER a column — only its hash (Principle IV).
    expect(hasField(inv!, 'token')).toBe(false);
    expect(columnIsIndexed(inv!, 'account_id')).toBe(true);
    expect(columnIsIndexed(inv!, 'expires_at')).toBe(true);
  });
});
