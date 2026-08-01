import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from '@crm/common';

/**
 * T051 (feature 025, roadmap 5.9 — FR-027): **routing never learns a label's name.**
 *
 * ── Why a table gets the guard a catalogue gets ─────────────────────────────────────────────────
 * `Break` · `Lunch` · `Meeting` · `VIP task` are a display layer over a state. They are stored in a
 * TABLE rather than a closed catalogue for two reasons pointing the same way: ADR 0042 §7 requires
 * administrators to edit the set, and every closed catalogue in this product is closed because a new
 * member CHANGES BEHAVIOUR — while a new label must change none.
 *
 * That last clause is the entire deliverable of US5, and it is only worth anything if somebody
 * checks it. The guard is the same one eight catalogues already carry (011 permissions, 014
 * automation vocabulary, 015 audit actions, 016 upload purposes, 017 export scopes, 021 UI
 * preferences, 023 transitions, 024 group names): **no code branches on the name.**
 *
 * The failure it prevents is not a crash. It is somebody writing `if (label === 'Lunch') skip()`,
 * which works, ships, and turns an editable word into a routing rule nobody can find.
 */

const REPO_ROOT = resolve(__dirname, '../..');
const ROOTS = ['services', 'libs/common/src', 'web/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.next', 'gen']);

function sources(root: string): string[] {
  const abs = resolve(REPO_ROOT, root);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(p);
    }
  };
  walk(abs);
  return out;
}

const FILES = ROOTS.flatMap(sources);
const rel = (p: string) => relative(REPO_ROOT, p).split(sep).join('/');
const read = (f: string) => stripComments(readFileSync(f, 'utf8'));

/** The seeded set. Their presence in production source is itself the smell. */
const SEEDED_LABELS = ['Break', 'Lunch', 'Meeting', 'VIP task'];

/** A comparison or switch against something called a label. */
const BRANCHES_ON_A_LABEL =
  /\b(?:label|l|lbl)(?:\?)?\.name\s*(?:===|!==|==|!=)|case\s+['"`](?:Break|Lunch|Meeting|VIP task)['"`]/;

describe('no code branches on a presence label (feature 025, FR-027)', () => {
  it('scanned a plausible number of files', () => {
    // Anti-vacuous. A broken walk returns [] and every assertion below then "passes".
    expect(FILES.length).toBeGreaterThan(300);
  });

  it('the detector actually fires on planted input', () => {
    expect(BRANCHES_ON_A_LABEL.test("if (label.name === 'Lunch') skip();")).toBe(true);
    expect(BRANCHES_ON_A_LABEL.test('if (l?.name !== "Break") return;')).toBe(true);
    expect(BRANCHES_ON_A_LABEL.test("switch (x) { case 'VIP task': break; }")).toBe(true);
    // …and not on the ordinary, legitimate uses.
    expect(BRANCHES_ON_A_LABEL.test('const name = label.name;')).toBe(false);
    expect(BRANCHES_ON_A_LABEL.test('return { id: l.id, name: l.name };')).toBe(false);
  });

  it('the comment-stripper is in the pipeline (so a note explaining the ban is not banned)', () => {
    const planted = `// never write label.name === 'Lunch'\nconst x = 1;`;
    expect(BRANCHES_ON_A_LABEL.test(planted)).toBe(true);
    expect(BRANCHES_ON_A_LABEL.test(stripComments(planted))).toBe(false);
  });

  it('no production source compares a label name', () => {
    const offenders = FILES.filter(
      (f) => !f.endsWith('.spec.ts') && BRANCHES_ON_A_LABEL.test(read(f)),
    ).map(rel);
    expect(offenders).toEqual([]);
  });

  it.each(SEEDED_LABELS)('the seeded label %p appears in NO production source', (label) => {
    // The seed may name them; the product may not. A literal here is how an editable word quietly
    // becomes a constant — the exact shape the group-name guard exists to prevent one feature over.
    const offenders = FILES.filter((f) => {
      const p = rel(f);
      if (p.endsWith('.spec.ts')) return false;
      // The seed's job is to CREATE them, so it is the one legitimate holder.
      if (p.includes('prisma/seed')) return false;
      return read(f).includes(`'${label}'`) || read(f).includes(`"${label}"`);
    }).map(rel);
    expect(offenders).toEqual([]);
  });

  it('⭐ the availability predicate takes no label at all', () => {
    // The strongest form of the guarantee: routing cannot branch on a label because the function
    // that decides availability has nowhere to put one.
    const states = read(resolve(REPO_ROOT, 'libs/common/src/presence/states.ts'));
    expect(states).not.toMatch(/\blabel\b/i);
  });

  it('⭐ the routing pool never reads a label either', () => {
    const pool = read(resolve(REPO_ROOT, 'services/chats/src/assignment/group-pool.ts'));
    expect(pool).not.toMatch(/\blabel/i);
    // …and the client that feeds it does not carry one across the wire.
    const client = read(resolve(REPO_ROOT, 'services/chats/src/person/person-members.client.ts'));
    expect(client).not.toMatch(/labelId|label_id/);
  });

  it('the label lives in a TABLE, not in a closed catalogue', () => {
    // If somebody moves it into `libs/common` as a frozen list, administrators lose the ability ADR
    // 0042 §7 requires them to have — and the move would look like tidying.
    const commonFiles = sources('libs/common/src').map(rel);
    expect(commonFiles.filter((f) => /presence-labels?|label-catalogue/.test(f))).toEqual([]);
  });
});
