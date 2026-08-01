import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stripComments } from '@crm/common';

/**
 * FR-002 / ADR 0039 §9 (feature 024) — **no group name is hardcoded, and no code branches on one.**
 *
 * The operator was explicit: keep the structure and the logic, do **not** bind to the present names or
 * the present groups. That is not a style preference. The eight groups in the system being replaced
 * are a mixed bag — a department unit, a queue folder, something closer to a job title — and the first
 * `if (group.name === 'VIP')` anywhere in the product turns an operator-editable label into a
 * deployment. Renaming a desk would then change behaviour, silently.
 *
 * This is the same guard the six earlier closed catalogues carry, aimed one level out: those ban an
 * unknown VALUE, this bans a known one.
 *
 * ── Detector discipline (the standing rule, four instances paid for) ────────────────────────────
 *  • comments are STRIPPED FIRST — a guard that bans a token also bans the note explaining why the
 *    token must not appear, and that note is the most valuable line in the file;
 *  • the scan asserts a PLAUSIBLE FILE COUNT, so a broken walk fails instead of passing over nothing;
 *  • the detector is proved on PLANTED input, so "no matches" means "looked and found none".
 */

/**
 * The names of the groups in the system being replaced (`cowork/zendesk-findings.md` § Groups & roles).
 * Present here as the thing to look FOR — this array is the test's input, never the product's.
 */
const REPLACED_SYSTEM_GROUP_NAMES = [
  'Deposit requests',
  'VIP Account Managers',
  'General Level 1 Support',
  'Directa24 Team',
  'PayCord Team',
];

/** Production trees only. Specs and fixtures legitimately name things. */
const ROOTS = [
  'services/auth/src',
  'services/users/src',
  'services/chats/src',
  'services/gateway/src',
  'services/brands/src',
  'services/worker/src',
  'libs/common/src',
];

const SKIP_DIRS = new Set(['generated', 'node_modules', 'dist']);

function sourceFiles(root: string): string[] {
  const abs = resolve(__dirname, '../..', root);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.endsWith('.ts')) continue;
      if (entry.endsWith('.spec.ts') || entry.endsWith('.test.ts')) continue;
      out.push(p);
    }
  };
  walk(abs);
  return out;
}

const FILES = ROOTS.flatMap(sourceFiles);

/** A comparison or switch against something called a name — the branch this guard exists to ban. */
const BRANCHES_ON_A_NAME =
  /\b(?:group|g|grp)(?:\?)?\.name\s*(?:===|!==|==|!=)|case\s+['"`](?:VIP|Support)['"`]/;

describe('no code branches on a group name (feature 024, FR-002)', () => {
  it('scanned a plausible number of production files', () => {
    // Anti-vacuous. A broken walk returns [] and every assertion below then "passes".
    expect(FILES.length).toBeGreaterThan(150);
  });

  it('the detector actually fires on planted input', () => {
    expect(BRANCHES_ON_A_NAME.test("if (group.name === 'VIP') doSomething();")).toBe(true);
    expect(BRANCHES_ON_A_NAME.test('if (g?.name !== "Support") return;')).toBe(true);
    expect(BRANCHES_ON_A_NAME.test("switch (x) { case 'VIP': break; }")).toBe(true);
    // …and does not fire on the ordinary, legitimate uses.
    expect(BRANCHES_ON_A_NAME.test('const name = group.name;')).toBe(false);
    expect(BRANCHES_ON_A_NAME.test('return { id: g.id, name: g.name };')).toBe(false);
  });

  it('the comment-stripper is in the pipeline (so a retraction note is not banned)', () => {
    const planted = `// never write group.name === 'VIP'\nconst x = 1;`;
    expect(BRANCHES_ON_A_NAME.test(planted)).toBe(true);
    expect(BRANCHES_ON_A_NAME.test(stripComments(planted))).toBe(false);
  });

  it.each(REPLACED_SYSTEM_GROUP_NAMES)('no production source contains the name %p', (name) => {
    const offenders = FILES.filter((f) => stripComments(readFileSync(f, 'utf8')).includes(name));
    expect(offenders).toEqual([]);
  });

  it('no production source compares a group name', () => {
    const offenders = FILES.filter((f) =>
      BRANCHES_ON_A_NAME.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });

  it('the group service treats a name as data: it stores, compares for COLLISION, and nothing else', () => {
    // The one legitimate comparison in the product is uniqueness, and it happens in the database
    // through `@@unique([account_id, name])` plus a lookup — never as a branch on a literal.
    const src = stripComments(
      readFileSync(resolve(__dirname, '../../services/auth/src/group/group.service.ts'), 'utf8'),
    );
    expect(src).toContain('normaliseName');
    expect(BRANCHES_ON_A_NAME.test(src)).toBe(false);
    for (const name of REPLACED_SYSTEM_GROUP_NAMES) expect(src).not.toContain(name);
  });
});
