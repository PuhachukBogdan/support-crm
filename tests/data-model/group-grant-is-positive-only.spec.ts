import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sourceLines } from '@crm/common';
import { parseSchema, hasField, type Model } from './schema-scan';
import { SCOPED_MODELS as AUTH } from '../../services/auth/src/prisma.scoped-models';

/**
 * SQL comments are `--`, and the shared `stripComments` from `@crm/common/testing` handles the
 * C-style `//` and `/* *\/` forms our TypeScript and Prisma files use. Stripping is still required
 * for the same reason it always is here: the migration deliberately EXPLAINS the absence of a
 * `granted` column, and a guard that banned the word outright would ban the note documenting why it
 * is missing — the collision this project has now hit four times.
 */
// ⚠️ `sourceLines`, not `split('\n')`: with `$` anchored at end-of-string and `.` unable to cross a `\r`,
// `--.*$` strips nothing on a CRLF working tree — the comment survives into the scan and can raise a
// FALSE POSITIVE. Milder than the vacuous direction the same mistake produced in
// `services/chats/tests/no-pii-logs.spec.ts`, and the same one-word fix.
const stripSqlComments = (sql: string): string =>
  sourceLines(sql)
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

/**
 * T007 (feature 024, roadmap 5.3 — ADR 0039 §3) — **a group grants and never denies**, asserted as a
 * property of the SCHEMA rather than of the code that writes to it.
 *
 * ── Why this is a structural test and not a behavioural one ─────────────────────────────────────
 * "We never write `granted: false`" is a convention, and conventions hold until the third feature
 * needs an exception under a deadline. "The column does not exist" is a guarantee: a denial through a
 * group is not merely unused, it is **unrepresentable**.
 *
 * The contrast with the neighbouring table is the whole point. `UserPermissionEntry` DOES carry
 * `granted Boolean @default(true)` — correctly, because it is a materialised snapshot of one person's
 * permissions and must be able to say "explicitly not". A group is not a snapshot; it is an ongoing
 * membership that can only add. This spec asserts both halves, so the day someone copies the entry
 * model to make the group model, it fails.
 *
 * ADR 0034's open item 1 ("does deny override allow?") stays genuinely open because of this. If a
 * group could deny, that question would have been answered by accident, in a corner of the group
 * model, by whoever wired the column.
 */
const AUTH_SCHEMA = resolve(__dirname, '../../services/auth/prisma/schema.prisma');

/** Field names that would introduce a negative or precedence-carrying grant. */
const FORBIDDEN_FIELDS = ['granted', 'denied', 'deny', 'allow', 'effect', 'priority', 'weight'];

function model(name: string): Model {
  const m = parseSchema('auth').find((x) => x.name === name);
  if (!m) throw new Error(`${name} is missing from the auth schema`);
  return m;
}

describe('GroupPermission — a grant is positive-only, by construction (feature 024)', () => {
  it('scans a schema that actually contains the group models (anti-vacuous)', () => {
    // Without this, every assertion below would pass just as happily against an empty parse.
    const names = parseSchema('auth').map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(['Group', 'GroupMember', 'GroupPermission']));
    expect(names.length).toBeGreaterThan(10);
  });

  it.each(FORBIDDEN_FIELDS)('has no `%s` field', (field) => {
    expect(hasField(model('GroupPermission'), field)).toBe(false);
  });

  it('carries nothing but the two ids — a row IS the grant', () => {
    const scalars = model('GroupPermission')
      .fields.filter((f) => !f.isRelation)
      .map((f) => f.name)
      .sort();
    expect(scalars).toEqual(['group_id', 'permission_id']);
  });

  it('the neighbouring per-user snapshot DOES have `granted`, and that difference is the design', () => {
    // Proves the detector can distinguish the two models rather than reporting "absent" for both —
    // i.e. it proves this suite is capable of failing.
    expect(hasField(model('UserPermissionEntry'), 'granted')).toBe(true);
  });

  it('a planted `granted` column would be caught', () => {
    // The detector runs against the parser, so prove the parser sees such a column when one exists.
    const planted = parseSchema('auth').find((m) => m.name === 'UserPermissionEntry');
    expect(planted?.fields.some((f) => f.name === 'granted' && f.baseType === 'Boolean')).toBe(true);
  });

  it('the group is a tenant table and is enrolled in the account-scope allow-list', () => {
    expect(hasField(model('Group'), 'account_id')).toBe(true);
    expect(AUTH).toContain('Group');
    // The two join tables scope through their parents and must NOT declare account_id — the same
    // treatment as UserRole / RolePermission. Declaring it would create a second, divergeable answer
    // to "which account is this membership in?".
    expect(hasField(model('GroupMember'), 'account_id')).toBe(false);
    expect(hasField(model('GroupPermission'), 'account_id')).toBe(false);
    expect(AUTH).not.toContain('GroupMember');
    expect(AUTH).not.toContain('GroupPermission');
  });

  it('membership is idempotent by primary key, not by an application check', () => {
    const ids = model('GroupMember').indexes.filter((i) => i.kind === 'id');
    expect(ids.map((i) => i.columns.join(','))).toContain('group_id,user_id');
  });

  it('has the resolver’s hot lookup index (which groups is this user in?)', () => {
    const idx = model('GroupMember').indexes.map((i) => i.columns.join(','));
    expect(idx).toContain('user_id');
  });

  it('a group name is unique per account, so two are always distinguishable', () => {
    const uniques = model('Group')
      .indexes.filter((i) => i.kind === 'unique')
      .map((i) => i.columns.join(','));
    expect(uniques).toContain('account_id,name');
  });

  it('has no `type` column — structural vs functional falls out of the bindings (ADR 0039 §5)', () => {
    expect(hasField(model('Group'), 'type')).toBe(false);
    expect(hasField(model('Group'), 'kind')).toBe(false);
  });

  it('has no brand dimension (ADR 0039 §10 — 0038 stands entirely)', () => {
    expect(hasField(model('Group'), 'brand_id')).toBe(false);
  });

  it('the migration that creates the table also declares no negative column', () => {
    // The schema and the SQL are written by hand in this repository and can drift. Comments are
    // stripped first: the migration deliberately EXPLAINS the absence of `granted`, and a guard that
    // banned the word outright would ban the note that documents why it is missing.
    const sql = stripSqlComments(
      readFileSync(
        resolve(
          __dirname,
          '../../services/auth/prisma/migrations/20260805000000_groups/migration.sql',
        ),
        'utf8',
      ),
    );
    expect(sql).toContain('CREATE TABLE "GroupPermission"');
    for (const field of FORBIDDEN_FIELDS) {
      expect(sql.toLowerCase()).not.toContain(`"${field}"`);
    }
  });

  it('the schema text explains the absence rather than leaving it to be rediscovered', () => {
    // A guarantee nobody can find is a guarantee nobody keeps. This is the one place where the
    // COMMENT is the artefact under test, so it is read unstripped, on purpose.
    const text = readFileSync(AUTH_SCHEMA, 'utf8');
    const marker = text.slice(text.indexOf('model GroupPermission') - 1200, text.indexOf('model GroupPermission'));
    expect(marker).toMatch(/never denies|no `granted`|NO `granted`/i);
  });
});
