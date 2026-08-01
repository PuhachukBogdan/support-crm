import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from '@crm/common';
import { parseSchema, hasField, type Model } from './schema-scan';

/**
 * T008 (feature 026, roadmap 5.7 — FR-002 / FR-003): **one active manager, and a past that survives.**
 *
 * ── The two requirements look opposed, and the index is what reconciles them ────────────────────
 *   • FR-002 🅿 — a player has ONE active manager.
 *   • FR-003 — assignment history is ADDITIVE: a move closes a period and adds another, never
 *     overwrites or deletes.
 *
 * An ordinary `@@unique([account, brand, player])` satisfies the first and destroys the second: it
 * would forbid a player from ever having *had* a second manager. A unique index **filtered to
 * `ended_at IS NULL`** gives both — the database refuses a second ACTIVE manager while every closed
 * period stays exactly where it is.
 *
 * ── ⚠️ Why this test reads the SQL and not the schema ───────────────────────────────────────────
 * Prisma has no first-class partial unique index, so the filter exists in **exactly one place**: the
 * hand-written migration. A schema comment describing it is a comment. Both files are hand-written
 * here and can drift, and the direction that drift goes in is silent — the schema would still look
 * right while the constraint was gone.
 *
 * ── What FR-003 is protecting, concretely ───────────────────────────────────────────────────────
 * Q3.2 (*are an AM's notes about the player, or about that manager's work?*) is unanswered. Additive
 * history is what keeps that question answerable **later at no migration cost**: whichever way the
 * operator decides, the record of who held the player when is still there.
 */

const REPO_ROOT = resolve(__dirname, '../..');
const MIGRATION = resolve(
  REPO_ROOT,
  'services/users/prisma/migrations/20260807000000_player_assignment/migration.sql',
);

/** SQL comments are `--`. Stripped for the same reason it always is here: the migration deliberately
 *  EXPLAINS the filter, and a guard that banned the word would ban the note documenting it. */
const stripSql = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

function model(name: string): Model {
  const m = parseSchema('users').find((x) => x.name === name);
  if (!m) throw new Error(`${name} is missing from the users schema`);
  return m;
}

// ── the source scan, for the "nothing deletes a row" half ────────────────────────────────────────
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.next', 'gen', 'migrations']);
function sources(root: string): string[] {
  const abs = resolve(REPO_ROOT, root);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(abs);
  return out;
}
const FILES = sources('services').concat(sources('libs'));
const rel = (p: string) => relative(REPO_ROOT, p).split(sep).join('/');

describe('assignment history is additive (feature 026)', () => {
  it('the model exists and was actually parsed (anti-vacuous)', () => {
    expect(parseSchema('users').map((m) => m.name)).toContain('PlayerAssignment');
    expect(model('PlayerAssignment').fields.length).toBeGreaterThan(6);
  });

  it('carries `ended_at` as the period marker', () => {
    const f = model('PlayerAssignment').fields.find((x) => x.name === 'ended_at');
    expect(f).toBeDefined();
    expect(f?.optional).toBe(true); // NULL = active
  });

  it('⚠️ has NO `active` boolean — the timestamp already says it', () => {
    // A flag beside a timestamp is two facts that can disagree, and nothing would notice which one
    // a given query trusted.
    for (const field of ['active', 'is_active', 'current']) {
      expect(hasField(model('PlayerAssignment'), field)).toBe(false);
    }
  });

  it('⭐ records WHO DECIDED separately from who looks after the player', () => {
    // Self-assignment makes the two equal most of the time, which is exactly why they must be two
    // columns: the abnormal-volume question ("who attached a hundred players this hour?") is asked
    // of `assigned_by`, and it matters most in the case where the answer is "themselves".
    expect(hasField(model('PlayerAssignment'), 'am_auth_user_id')).toBe(true);
    expect(hasField(model('PlayerAssignment'), 'assigned_by')).toBe(true);
  });

  it('keys the player by the FULL identity, never a bare platform id', () => {
    // Feature 020: the same `player_id` under two brands is routinely two different human beings.
    for (const field of ['account_id', 'brand_id', 'player_id']) {
      expect(hasField(model('PlayerAssignment'), field)).toBe(true);
    }
  });

  it('⭐ the migration creates a PARTIAL unique index, filtered to the active row', () => {
    const sql = stripSql(readFileSync(MIGRATION, 'utf8'));
    expect(sql).toContain('CREATE TABLE "PlayerAssignment"');

    // The index, and the FILTER. The filter is the whole point: without it, FR-003 is impossible.
    const idx = /CREATE UNIQUE INDEX[\s\S]*?;/.exec(sql)?.[0] ?? '';
    expect(idx).toMatch(/"account_id",\s*"brand_id",\s*"player_id"/);
    expect(idx).toMatch(/WHERE\s+"ended_at"\s+IS\s+NULL/i);
  });

  it('the detector would notice an UNFILTERED unique index (proved on planted input)', () => {
    // Without this, the assertion above passes for any file containing the word WHERE somewhere.
    const planted = 'CREATE UNIQUE INDEX "x" ON "PlayerAssignment"("account_id","brand_id","player_id");';
    expect(/WHERE\s+"ended_at"\s+IS\s+NULL/i.test(planted)).toBe(false);
  });

  it('the schema does NOT declare an ordinary @@unique on the same columns', () => {
    // Belt and braces: an `@@unique` added later "for safety" would silently forbid history.
    const uniques = model('PlayerAssignment')
      .indexes.filter((i) => i.kind === 'unique')
      .map((i) => i.columns.join(','));
    expect(uniques).not.toContain('account_id,brand_id,player_id');
  });

  it('⭐ no code anywhere DELETES an assignment row', () => {
    // Detaching closes a period. A delete would destroy the answer to "who used to look after this
    // player", which is the question FR-003 exists to preserve.
    const banned = /playerAssignment\s*\.\s*(delete|deleteMany)\s*\(/;
    const offenders = FILES.filter((f) => banned.test(stripComments(readFileSync(f, 'utf8')))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('its own detector works on planted samples', () => {
    const banned = /playerAssignment\s*\.\s*(delete|deleteMany)\s*\(/;
    expect(banned.test('await db.playerAssignment.deleteMany({ where: {} })')).toBe(true);
    expect(banned.test('await db.playerAssignment.update({ where, data })')).toBe(false);
    expect(banned.test(stripComments('// never playerAssignment.delete(...) — history is additive'))).toBe(false);
  });

  it('the three purpose-built indexes are present, including the monitoring one', () => {
    const idx = model('PlayerAssignment').indexes.filter((i) => i.kind === 'index').map((i) => i.columns.join(','));
    expect(idx).toContain('account_id,brand_id,player_id,ended_at'); // the narrowing's lookup
    expect(idx).toContain('account_id,am_auth_user_id,ended_at'); // "my players"
    // ⭐ Exists ONLY so the abnormal-volume question does not need a scan. Without it, a monitoring
    // signal quietly becomes something nobody runs.
    expect(idx).toContain('account_id,assigned_by,started_at');
  });
});
