import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * T015a (feature 031, ADR 0042) — a desk is a routed queue only when somebody says so.
 *
 * ⚠️ **The default is what this guard protects, not the column.** Defaulting `routable` to true would make
 * every existing group a routed queue on deploy — including the account managers' desks — so the migration
 * itself would open the hole roadmap 4.14 exists to close, and it would open it silently: the router keeps
 * answering successfully and the only symptom is a manager quietly holding somebody else's work.
 *
 * A test on the schema text is the cheapest place to pin that, because the alternative is noticing it in
 * production.
 */
describe('Group.routable — automatic distribution is opt-in per desk', () => {
  const here = (...p: string[]) => join(__dirname, '..', '..', 'prisma', ...p);
  const schema = readFileSync(here('schema.prisma'), 'utf8');

  it('⚠️ defaults to FALSE, so a migration cannot silently start routing to every desk', () => {
    expect(schema).toMatch(/routable\s+Boolean\s+@default\(false\)/);
    // …and nowhere does it default to true, however the line is formatted.
    expect(schema).not.toMatch(/routable\s+Boolean\s+@default\(true\)/);
  });

  it('⭐ is a DIFFERENT fact from `active`, and both still exist', () => {
    // An inactive desk does not exist for anybody; a non-routable desk is a perfectly good desk whose
    // members are assigned work by hand — an AM's book of business is exactly that. Collapsing the two
    // would force an administrator to DELETE a working desk to stop it receiving pushed work.
    expect(schema).toMatch(/active\s+Boolean\s+@default\(true\)/);
    expect(schema).toMatch(/routable\s+Boolean/);
  });

  it('the migration adds it additively, with the same default as the schema', () => {
    // A default that disagrees between schema and migration is a fixture that works locally and a
    // production table that routes to everybody.
    const sql = readFileSync(here('migrations', '20260807000000_group_routable', 'migration.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE "Group" ADD COLUMN "routable" BOOLEAN NOT NULL DEFAULT false/);
    expect(sql).not.toMatch(/DEFAULT true/);
  });
});
