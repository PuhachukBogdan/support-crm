import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * ⭐ **NO TRACKED `*.sh` MAY CARRY CRLF IN THE WORKING TREE** (found 2026-08-05, running `live-w3.sh`).
 *
 * ── Why `.gitattributes` is not enough, which is the whole point ─────────────────────────────────
 * `.gitattributes` already says `*.sh text eol=lf`, and it works: git STORED `live-w3.sh` with LF. But
 * `eol=lf` normalizes on **checkout and commit** — a file written into the working tree by an editor on
 * Windows and never checked out again keeps the CRLF it was born with. The repository was correct and the
 * working copy was not, at the same time.
 *
 * That difference reaches the stand because the sync reads the WORKING TREE (`git ls-files | tar`), not the
 * commit. So a script that is LF in git arrived on Linux as CRLF and died on its own `set -u`:
 *
 *   live-w3.sh: line 23: set: -: invalid option
 *   live-w3.sh: line 38: $'\r': command not found
 *
 * ⚠️ Note what that cost: the first live round of a block reported four shell syntax errors, which looks
 * exactly like a broken script and nothing like a transport problem. `.gitattributes`'s own comment
 * records the same class biting feature 009's first Track-B sync (a postgres init script, same cause), so
 * this is the second occurrence — and the fix that time was a rule the process could still walk past.
 *
 * ⇒ A convention enforced only at a git boundary does not protect a path that does not cross it.
 */
const ROOT = resolve(__dirname, '..', '..');

/** The tracked set, so an untracked scratch script on somebody's box is not this test's business. */
function trackedShellScripts(): string[] {
  return execFileSync('git', ['ls-files', '*.sh'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

describe('shell scripts are LF in the working tree, not merely in git', () => {
  const scripts = trackedShellScripts();

  it('finds shell scripts to check — a guard over an empty set proves nothing', () => {
    expect(scripts.length).toBeGreaterThan(2);
  });

  it.each(scripts)('%s has no CRLF line ending', (relPath) => {
    const raw = readFileSync(join(ROOT, relPath), 'utf8');
    const crlf = (raw.match(/\r\n/g) ?? []).length;
    expect(crlf).toBe(0);
  });
});
