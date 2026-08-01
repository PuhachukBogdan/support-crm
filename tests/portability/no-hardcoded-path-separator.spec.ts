import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from '@crm/common';

/**
 * **A path separator is never a string literal.** (Added after the feature-024 push turned CI red.)
 *
 * ── What happened ───────────────────────────────────────────────────────────────────────────────
 * `tests/naming/personalize-group-disambiguated.spec.ts` relativised a path by hand:
 *
 *     p.replace(resolve(__dirname, '../..') + '\\', '')      // ⚠️ Windows separator, hardcoded
 *
 * That is correct on the machine it was written on and inert everywhere else. CI runs on
 * `ubuntu-latest`, where the replace matched nothing, every scanned path stayed **absolute**, and a
 * pin comparing `services/gateway/src/rbac/…` received
 * `/home/runner/work/crm-foundation/crm-foundation/services/gateway/src/rbac/…`. The whole local
 * gate was green — 2 950 tests — because the defect is invisible to the only operating system that
 * ran them.
 *
 * ── Why this deserves a guard rather than a fix ─────────────────────────────────────────────────
 * This is the **second** time the Windows/Linux split has cost a red build: `.gitattributes` still
 * carries the note about a CRLF shebang (`#!/bin/bash\r`) that was unexecutable inside a Linux
 * container during feature 009's first live sync. Both have the same shape — *a difference the
 * author's machine cannot see* — and no amount of care before pushing detects one, because care is
 * exactly what is already being applied. Only a check that runs **on the author's platform** and
 * reasons about the **other** one closes it.
 *
 * So the rule is not "write the right separator". It is: **do not do path arithmetic with string
 * surgery.** `node:path` has `relative`, `join` and `sep` precisely so that no source in this
 * repository has to know which operating system it is on.
 *
 * ── The rule, exactly ───────────────────────────────────────────────────────────────────────────
 * No source file may contain a string literal whose entire content is a single backslash —
 * `'\\'`, `"\\"` or the backtick form. That is the separator-as-a-literal shape and nothing else:
 *
 *   • `/\\/g` — a regex literal normalising backslashes to slashes — is **allowed**. It is a no-op
 *     on Linux and is how `relative()`'s native output is respelled.
 *   • `` `rpc\\s+${name}` `` — a regex built from a template string — is **allowed**; the backslashes
 *     are regex escapes, not paths.
 *   • `'C:\\Users\\…'` — a Windows path used as deliberate TEST DATA (the upload filename
 *     sanitiser) — is **allowed**; the literal is not *just* a separator.
 *
 * ── Comments are stripped first, and that is not a detail ───────────────────────────────────────
 * This repository has now hit the same collision five times: **a guard that bans a shape also bans
 * the note explaining why the shape is banned.** The paragraph above literally has to spell
 * `'\\'` to be readable, and the file it fixed has to quote the line that broke CI. Scanning raw
 * text would make both un-writable, so the one honest reading of "no source hardcodes a separator"
 * is *no CODE does*.
 *
 * ── Two survivors, pinned rather than bounded ───────────────────────────────────────────────────
 * Neither is path handling, and that is the whole test of whether an exception is real:
 *   • the comment stripper's own lexer, which must recognise an escape character to know it is
 *     inside a string;
 *   • the upload filename sanitiser's test, which feeds it a bare backslash as hostile input.
 * They are **pinned by name**, not merely allowed: a THIRD file acquiring the shape is a new claim
 * and has to argue for itself here. No marker is demanded at either site, deliberately — unlike the
 * feature-024 naming guard, a reader standing at `src[i] === '\\'` inside a lexer is not misled
 * about what they are looking at.
 *
 * Pure filesystem read + a regex. No product code involved.
 */

const REPO_ROOT = resolve(__dirname, '../..');

/** Where source lives. `generated`/`dist`/`node_modules` are not ours to police. */
const ROOTS = ['tests', 'services', 'libs', 'web/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.next', 'gen', 'migrations']);

/**
 * A quote, two literal backslashes, the same quote — i.e. a string whose whole content is one
 * backslash. Deliberately anchored on the quotes: that is what makes it a *separator* rather than
 * an escape inside a longer literal.
 */
const SEPARATOR_AS_LITERAL = /(['"`])\\\\\1/;

/**
 * The only two places a bare-backslash literal is real code, and neither manipulates a path.
 * Pinned, not bounded — see the header.
 */
const SANCTIONED = [
  'libs/common/src/testing/strip-comments.ts', // the lexer: an escape char is what it must detect
  'libs/common/src/uploads/filename.spec.ts', // hostile input handed to the filename sanitiser
];

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

describe('a path separator is never a string literal', () => {
  it('scanned a plausible number of files', () => {
    // Anti-vacuous: a broken walk returns [] and everything below "passes".
    expect(FILES.length).toBeGreaterThan(300);
  });

  it('the detector fires on the exact line that broke CI', () => {
    expect(SEPARATOR_AS_LITERAL.test(`p.replace(root + '\\\\', '')`)).toBe(true);
    expect(SEPARATOR_AS_LITERAL.test(`p.split("\\\\")`)).toBe(true);
    expect(SEPARATOR_AS_LITERAL.test('const s = `\\\\`;')).toBe(true);
  });

  it('the detector leaves the three legitimate neighbours alone', () => {
    // A regex literal that respells native output. Allowed — and used by the fix itself.
    expect(SEPARATOR_AS_LITERAL.test(`x.replace(/\\\\/g, '/')`)).toBe(false);
    // Regex escapes inside a longer template string.
    expect(SEPARATOR_AS_LITERAL.test('new RegExp(`rpc\\\\s+${name}`)')).toBe(false);
    // A Windows path as deliberate test DATA (the upload filename sanitiser owns this one).
    expect(SEPARATOR_AS_LITERAL.test(`['C:\\\\Users\\\\x\\\\a.png', 'a.png']`)).toBe(false);
    // The POSIX separator is not banned: it is what `sep` is respelled TO, and it is inert on
    // Windows for every Node path API. Banning it would ban the fix.
    expect(SEPARATOR_AS_LITERAL.test(`parts.join('/')`)).toBe(false);
  });

  it('the comment-stripper is in the pipeline (so this file may explain itself)', () => {
    const planted = `// the shape is p.replace(root + '\\\\', '')\nconst x = 1;`;
    expect(SEPARATOR_AS_LITERAL.test(planted)).toBe(true);
    expect(SEPARATOR_AS_LITERAL.test(stripComments(planted))).toBe(false);
  });

  it('no source hardcodes a separator', () => {
    const holders = FILES.filter((f) =>
      SEPARATOR_AS_LITERAL.test(stripComments(readFileSync(f, 'utf8'))),
    ).map(rel);
    // If this fails: use `relative()` / `join()` / `sep` from `node:path`. Reaching for the other
    // separator instead just moves which operating system is wrong.
    expect(holders.filter((f) => !SANCTIONED.includes(f))).toEqual([]);
  });

  it('the sanctioned two are still there, so the allow-list is not covering a hole', () => {
    // A pinned exception that has silently stopped applying is an exception nobody is checking.
    const holders = FILES.filter((f) =>
      SEPARATOR_AS_LITERAL.test(stripComments(readFileSync(f, 'utf8'))),
    ).map(rel);
    expect(holders.sort()).toEqual([...SANCTIONED].sort());
  });

  it('this guard is itself platform-independent, and says so by example', () => {
    // `rel` here uses the sanctioned spelling. Proving it round-trips a real file means this file
    // cannot quietly acquire the very defect it polices.
    const sample = resolve(REPO_ROOT, 'services', 'gateway', 'src', 'ws', 'ingress.gateway.ts');
    expect(rel(sample)).toBe('services/gateway/src/ws/ingress.gateway.ts');
  });
});
