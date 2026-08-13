import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { stripComments } from '@crm/common';
import { parseSchema, type Model } from './schema-scan';

/**
 * W35 / feature 040 — **a player note cannot be changed or removed**, and this is what makes that a
 * property of the product rather than a promise in a comment.
 *
 * ── Why a structural test and not a unit test ────────────────────────────────────────────────────
 * A unit test can only show that the verbs which exist behave; it cannot show that no verb exists. And
 * the requirement here is an ABSENCE — Q20 settled editability with a scenario rather than a preference:
 * if a note can be edited, then *«вписал, показал кому надо, стёр, и в системе чисто»*, i.e. the note
 * becomes a way to show somebody something and then make it never have happened. The day somebody adds
 * an innocent-looking `PATCH /notes/:id` for a typo, every existing test still passes.
 *
 * Three independent statements, deliberately overlapping — the schema, the contract, and the code:
 * a feature that has to defeat all three to regress cannot regress by accident.
 */
const ROOT = resolve(__dirname, '..', '..');
const PROTO = resolve(ROOT, 'libs/proto/crm/users/v1/users.proto');
const MIGRATION = resolve(
  ROOT,
  'services/users/prisma/migrations/20260813000000_player_notes/migration.sql',
);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'gen' || entry === 'dist' || entry === 'generated') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(entry) && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const rel = (abs: string): string => abs.slice(ROOT.length + 1).split(sep).join('/');

const SOURCES = walk(join(ROOT, 'services')).map((abs) => ({
  path: rel(abs),
  code: stripComments(readFileSync(abs, 'utf8')),
}));

const protoText = readFileSync(PROTO, 'utf8');

describe('the scan reads the real artefacts (nothing below can pass vacuously)', () => {
  it('sees the whole backend and the file that owns the notes', () => {
    expect(SOURCES.length).toBeGreaterThan(150);
    expect(SOURCES.map((s) => s.path)).toContain(
      'services/users/src/player/player-note.repository.ts',
    );
  });

  it('the comment stripper keeps code and drops prose about code', () => {
    expect(stripComments('const a = 1; // playerNote.update')).toContain('const a = 1;');
    expect(stripComments('const a = 1; // playerNote.update')).not.toContain('playerNote.update');
  });
});

describe('*** the SCHEMA has nothing an update could touch ***', () => {
  const note: Model = (() => {
    const found = parseSchema('users').find((m) => m.name === 'PlayerNote');
    if (!found) throw new Error('PlayerNote model not found in the users schema');
    return found;
  })();

  it('carries no mutable column — no updated_at, no revision, no deleted_at', () => {
    const columns = note.fields.map((f) => f.name);
    // R35 asked for revisions, on the assumption that notes would be editable. Q20 answered that they
    // are not, which makes a revision column not merely unnecessary but an invitation.
    for (const forbidden of ['updated_at', 'revision', 'deleted_at', 'edited_at', 'edited_by']) {
      expect({ column: forbidden, present: columns.includes(forbidden) }).toEqual({
        column: forbidden,
        present: false,
      });
    }
  });

  it('carries the columns the signature needs (so the absence above is not an empty table)', () => {
    const columns = note.fields.map((f) => f.name);
    for (const required of ['body', 'author_auth_user_id', 'created_at', 'pattern_kinds', 'client_ref']) {
      expect({ column: required, present: columns.includes(required) }).toEqual({
        column: required,
        present: true,
      });
    }
  });

  it('the migration creates the table and issues no UPDATE or DELETE of its own', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/CREATE TABLE "PlayerNote"/);
    // ⚠️ `--` comments stripped FIRST, and this is the shared-testing rule doing its job on its own
    // author: the migration's prose explains why there is nothing an UPDATE could touch, and the first
    // draft of this assertion failed on that very sentence. *A guard that bans a token from the source
    // must not ban it from the comment documenting its removal.*
    const statements = sql.replace(/^\s*--.*$/gm, '');
    // No data statements at all — including the deliberate absence of an `am_notes` backfill, which the
    // migration's own header explains: that column never had a writer, so there is nothing to carry.
    expect(statements).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bINSERT\b/i);
  });
});

describe('*** the CONTRACT offers no verb to call ***', () => {
  const service = /service\s+PlayerNotesService\s*\{([\s\S]*?)\n\}/.exec(protoText);

  it('the notes service is in the contract', () => {
    expect(service).not.toBeNull();
  });

  it('it declares EXACTLY two rpcs: list and add', () => {
    const rpcs = [...service![1]!.matchAll(/rpc\s+(\w+)\s*\(/g)].map((m) => m[1]!);
    expect(rpcs.sort()).toEqual(['AddPlayerNote', 'ListPlayerNotes']);
  });

  it('no rpc anywhere in the users contract names a note mutation', () => {
    // Not scoped to the service block: a helpful `UpdatePlayerNote` added to `UsersMaintenanceService`
    // would be exactly as fatal to the guarantee, and less likely to be noticed.
    const rpcs = [...protoText.matchAll(/rpc\s+(\w+)\s*\(/g)].map((m) => m[1]!);
    const offenders = rpcs.filter((name) => /(?:Update|Delete|Edit|Remove|Patch)\w*Note/i.test(name));
    expect(offenders).toEqual([]);
  });
});

describe('*** the CODE contains no mutation of the model ***', () => {
  /** Every Prisma verb that could change or remove a stored row. */
  const MUTATIONS = [
    'update',
    'updateMany',
    'upsert',
    'delete',
    'deleteMany',
    'createManyAndReturn',
  ];

  it('nothing in the backend mutates `playerNote`', () => {
    const pattern = new RegExp(`\\bplayerNote\\s*\\.\\s*(?:${MUTATIONS.join('|')})\\b`);
    const offenders = SOURCES.filter((s) => pattern.test(s.code)).map((s) => s.path);
    expect(offenders).toEqual([]);
  });

  it('nor through a raw statement naming the table', () => {
    const raw = /(?:UPDATE|DELETE\s+FROM)\s+"?PlayerNote"?/i;
    const offenders = SOURCES.filter((s) => raw.test(s.code)).map((s) => s.path);
    expect(offenders).toEqual([]);
  });

  it('the repository exposes only append and read methods', () => {
    const repo = SOURCES.find(
      (s) => s.path === 'services/users/src/player/player-note.repository.ts',
    )!;
    const methods = [...repo.code.matchAll(/^\s{2}(?:async\s+)?(\w+)\s*\(/gm)].map((m) => m[1]!);
    expect(methods.sort()).toEqual(['append', 'constructor', 'findByClientRef', 'listForPlayer']);
  });

  it('the predicates FIRE on a real mutation (so the emptiness above means something)', () => {
    const pattern = new RegExp(`\\bplayerNote\\s*\\.\\s*(?:${MUTATIONS.join('|')})\\b`);
    expect(pattern.test('await db.playerNote.update({ where: { id } })')).toBe(true);
    expect(pattern.test('await db.playerNote.deleteMany({})')).toBe(true);
    expect(pattern.test('await db.playerNote.create({ data })')).toBe(false);
    // …and are not fooled by the comment that documents the ban.
    expect(pattern.test(stripComments('// never call playerNote.delete here'))).toBe(false);
  });
});
