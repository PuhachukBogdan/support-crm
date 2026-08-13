import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * MVP block W1 (roadmap 1.7) — ONE password per person, asserted structurally.
 *
 * ── Why a test that reads schema text ────────────────────────────────────────────────────────────
 * The guarantee is not in any function: `LoginService` reads the password with
 * `findFirst({ user_id, type: 'password' })` and no ordering, and that is *correct only while a
 * second row cannot exist*. A live run found two (one hand-made during feature 024, one from the
 * seed), which makes the verified hash a matter of Postgres row order — a correct password refused,
 * or a superseded one still working.
 *
 * So the invariant lives in the schema, and this test is what makes removing it visible. Deleting the
 * `@@unique` would otherwise break nothing until somebody's password mysteriously stopped working.
 *
 * Both the schema AND the migration are checked: the schema is what Prisma's client believes, the
 * migration is what the database actually enforces, and this repository has already been bitten by
 * the two disagreeing.
 */

const HERE = __dirname;

describe('Credential: one per type per user (roadmap 1.7)', () => {
  const schema = readFileSync(join(HERE, 'schema.prisma'), 'utf8');

  it('the schema declares the unique on (user_id, type)', () => {
    const model = schema.slice(schema.indexOf('model Credential'));
    const body = model.slice(0, model.indexOf('\n}'));
    expect(body).toMatch(/@@unique\(\[user_id,\s*type\]\)/);
  });

  it('a migration actually creates the constraint in the database', () => {
    const dirs = readdirSync(join(HERE, 'migrations'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);

    const sql = dirs
      .map((d) => readFileSync(join(HERE, 'migrations', d, 'migration.sql'), 'utf8'))
      .join('\n');

    expect(sql).toMatch(/CREATE UNIQUE INDEX[\s\S]*?"Credential"\s*\(\s*"user_id",\s*"type"\s*\)/);
  });

  it('and it resolves pre-existing duplicates rather than failing on them', () => {
    // A migration that only creates the index would abort on any database that already holds two —
    // which is exactly the state the stand was in when this was found.
    const dirs = readdirSync(join(HERE, 'migrations'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const sql = dirs
      .map((d) => readFileSync(join(HERE, 'migrations', d, 'migration.sql'), 'utf8'))
      .join('\n');

    const credentialDedupe = /DELETE FROM "Credential"[\s\S]*?created_at/;
    expect(sql).toMatch(credentialDedupe);
  });
});
