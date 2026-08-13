import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

/**
 * **A workspace that holds specs must have a `test` script** (added 2026-08-05, W4).
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * `npm test` is `test:root && npm run test --workspaces --if-present`. **`--if-present` is the hazard**: a
 * workspace whose `package.json` has no `test` script is skipped *silently and successfully*. Nothing goes
 * red, no count changes visibly, and the suite reports success — a skipped suite and a passing one look
 * identical from the outside.
 *
 * ⓘ **Nothing is currently broken, and the story behind this file is worth keeping honest.** It was written
 * while chasing what looked like 23 dead spec files in `libs/common` — 384 tests that appeared to have
 * never run. They ran the whole time. What had actually happened is that a hand-written per-workspace tally
 * (root + six services + web) omitted `libs/*` entirely, so when a function and its 5 tests moved INTO the
 * library, the worker's count dropped and nothing appeared to rise.
 *
 * ⇒ **The measurement was vacuous, not the suite.** Which is the same class this project keeps
 * re-learning, one level up: *ask what else would explain the number you are looking at.* The guard stays
 * because the `--if-present` hole it covers is real and would be invisible in exactly this way — but its
 * header does not get to claim a defect that was mine.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 */
const ROOT = resolve(__dirname, '..', '..');

/** The workspace globs from the root `package.json`, resolved to directories. */
function workspaceDirs(): string[] {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    workspaces?: string[];
  };
  const out: string[] = [];
  for (const pattern of pkg.workspaces ?? []) {
    if (pattern.endsWith('/*')) {
      const parent = join(ROOT, pattern.slice(0, -2));
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent)) {
        const dir = join(parent, entry);
        if (statSync(dir).isDirectory() && existsSync(join(dir, 'package.json'))) out.push(dir);
      }
    } else {
      const dir = join(ROOT, pattern);
      if (existsSync(join(dir, 'package.json'))) out.push(dir);
    }
  }
  return out;
}

/** Does this workspace contain any spec/test file of its own? */
function hasSpecs(dir: string): boolean {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'generated' || entry === '.next' || entry === 'dist') {
        continue;
      }
      const full = join(current, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else if (/\.(spec|test)\.(ts|tsx)$/.test(entry)) return true;
    }
  }
  return false;
}

describe('every workspace that holds specs actually runs them', () => {
  const dirs = workspaceDirs();

  it('found the workspaces (a guard over an empty set proves nothing)', () => {
    expect(dirs.length).toBeGreaterThanOrEqual(8);
  });

  it.each(dirs.map((d) => [relative(ROOT, d).split(sep).join('/'), d]))(
    '%s: has a `test` script if it has specs',
    (_name, dir) => {
      if (!hasSpecs(dir as string)) return;
      const pkg = JSON.parse(readFileSync(join(dir as string, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      };
      // ⚠️ The assertion is on the SCRIPT: `--if-present` keys off the script's existence, so a jest config
      // with no script to invoke it would be skipped exactly as if the specs were not there.
      expect(typeof pkg.scripts?.test).toBe('string');
    },
  );

  /**
   * The positive control for the detector itself. If `hasSpecs` ever stopped finding files, every case
   * above would pass by returning early — the same vacuous shape, one level up.
   */
  it('the spec detector finds specs where they demonstrably are', () => {
    expect(hasSpecs(join(ROOT, 'libs', 'common'))).toBe(true);
    expect(hasSpecs(join(ROOT, 'services', 'chats'))).toBe(true);
  });

  /**
   * ⭐ And the lesson the false alarm actually earned: a per-workspace tally must cover EVERY workspace, or
   * a suite can move between them unnoticed. Asserted so a future reader counting by hand is told the list.
   */
  it('names every workspace, so no hand-written tally can omit one', () => {
    const names = dirs.map((d) => relative(ROOT, d).split(sep).join('/')).sort();
    expect(names).toEqual([
      'libs/common',
      'libs/proto',
      'services/auth',
      'services/brands',
      'services/chats',
      'services/gateway',
      'services/users',
      'services/worker',
      'web',
    ]);
  });
});
