import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T020 [027] — nothing in this application stores a session, a token, a password or a code in the
 * browser.
 *
 * ── Why it is worth a structural test ───────────────────────────────────────────────────────────
 * The session lives in `httpOnly` cookies the page cannot read, which is what closes the
 * XSS→token-theft path (SEC-11). That guarantee is not a property of the cookie alone: it survives
 * only for as long as nobody copies anything session-shaped into `localStorage` "just for
 * convenience". The demo did exactly that — `mock-session.ts` kept a flag there — and removing it
 * is part of this point.
 *
 * ── Scoped to session-shaped values, deliberately ───────────────────────────────────────────────
 * ⚠️ It does **not** ban browser storage outright. A blanket ban would fail the first time somebody
 * legitimately remembered a collapsed sidebar, and a guard that fails for legitimate reasons gets
 * deleted — taking the real guarantee with it (the same reasoning that keeps the frozen-visual pin
 * narrow). What is banned is storing anything that names a credential.
 *
 * A cookie write is banned outright, with no keyword condition: the gateway is the only thing in
 * this system that may set a cookie, and a page has no legitimate reason to write one.
 */

const ROOTS = [join(__dirname, '..'), join(__dirname, '..', '..', 'app')];

/** Words that make a stored value a credential. */
const CREDENTIAL_ISH = /session|token|password|passcode|\bcode\b|credential|auth|secret|jwt/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Comments are stripped: prose ABOUT not storing a token must not read as storing one. */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

function codeOf(file: string): string {
  return stripComments(readFileSync(file, 'utf8'));
}

/** Every storage write in the source, with the statement it sits in. */
export function storageWrites(source: string): { call: string; statement: string }[] {
  const out: { call: string; statement: string }[] = [];
  const write = /(localStorage|sessionStorage)\s*\.\s*setItem\s*\(|document\s*\.\s*cookie\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = write.exec(source)) !== null) {
    const lineStart = source.lastIndexOf('\n', m.index) + 1;
    const end = source.indexOf(';', m.index);
    out.push({
      call: m[0],
      statement: source.slice(lineStart, end === -1 ? source.length : end),
    });
  }
  return out;
}

describe('structure guard — no session, token, password or code is kept in the browser', () => {
  const files = ROOTS.flatMap(walk);
  const writes = files.flatMap((f) => storageWrites(codeOf(f)).map((w) => ({ ...w, file: f })));

  it('the detector finds planted violations', () => {
    const planted = [
      `window.localStorage.setItem('crm.session', flag);`,
      `sessionStorage.setItem('accessToken', t);`,
      `document.cookie = 'access=' + token;`,
    ].join('\n');
    const found = storageWrites(planted);
    expect(found).toHaveLength(3);
    expect(found.every((w) => CREDENTIAL_ISH.test(w.statement))).toBe(true);
  });

  it('the detector ignores a comment that merely discusses one', () => {
    // This file's own header talks about `localStorage` at length. Without the strip, the guard
    // would report every file that documents the rule as breaking it.
    const prose = `// never call localStorage.setItem('session', flag) here\nconst x = 1;`;
    expect(storageWrites(stripComments(prose))).toEqual([]);
  });

  it('actually scanned the application tree', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no credential-shaped value is written to browser storage', () => {
    const offenders = writes
      .filter((w) => CREDENTIAL_ISH.test(w.statement))
      .map((w) => `${w.file}: ${w.statement.trim()}`);
    expect(offenders).toEqual([]);
  });

  it('nothing writes a cookie at all — that is the gateway’s job', () => {
    const offenders = writes.filter((w) => w.call.includes('cookie')).map((w) => w.file);
    expect(offenders).toEqual([]);
  });
});
