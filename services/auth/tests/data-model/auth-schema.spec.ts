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
