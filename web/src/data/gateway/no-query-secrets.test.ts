import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T007 [027] — FR-015 / Principle IV: **no auth call may carry a query string.**
 *
 * ── Why this is structural and not a unit assertion ─────────────────────────────────────────────
 * The values at risk here are a password, a one-time code and an invite token. A URL is written to
 * the browser's history, to every proxy access log between the browser and the service, and to the
 * gateway's own request log — none of which are places this project is allowed to put those three
 * strings. A unit test proves the call it happens to make; this proves the property for every auth
 * call that exists, including the one somebody adds next year in a hurry.
 *
 * The port now accepts a `body`, so the tempting shortcut is real: `query` is a `Record<string,
 * string>` and would have carried a code perfectly well. `research.md` records it in the rejected
 * column for exactly that reason.
 *
 * ── The detector proves itself first ────────────────────────────────────────────────────────────
 * Two guards in this repository were vacuous for their whole lives (`no-direct-network.test.ts`
 * scanned for a directory that never existed; feature 026's security assertion passed while the
 * fixture had silently failed). So: the detector is demonstrated on a planted violation, and the
 * scan asserts it actually found auth call sites before concluding they are clean.
 */

const ROOTS = [join(__dirname, '..', '..'), join(__dirname, '..', '..', '..', 'app')];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * A request literal is read by balancing braces, so a nested `body: {…}` does not truncate it.
 *
 * ⚠️ It must be an ARGUMENT — `foo({ path: '/auth/…' })`, not any object that happens to carry a
 * matching `path` field. The first draft of this guard omitted that condition and reported five
 * "auth call sites" on a day when none existed: it was matching the `AUTH_RECORDINGS` table in
 * `conformance/subjects.ts`, which declares the same paths as data. The corpus assertion below was
 * therefore green while guarding nothing — the fifth instance in this repository of a check that
 * passed by measuring the wrong thing.
 */
export function authRequestLiterals(source: string): string[] {
  const out: string[] = [];
  const pathAt = /path:\s*[`'"]\/auth\b/g;
  let m: RegExpExecArray | null;
  while ((m = pathAt.exec(source)) !== null) {
    let open = m.index;
    while (open >= 0 && source[open] !== '{') open -= 1;
    if (open < 0) continue;
    // The brace must open an argument list: walk back over whitespace and require a `(`.
    let before = open - 1;
    while (before >= 0 && /\s/.test(source[before]!)) before -= 1;
    if (source[before] !== '(') continue;
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          out.push(source.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

const CARRIES_QUERY = /\bquery\s*:/;

describe('structure guard — no auth call carries a query string (FR-015)', () => {
  const files = ROOTS.flatMap(walk);
  const literals = files.flatMap((f) => authRequestLiterals(codeOf(f)).map((lit) => ({ f, lit })));

  it('the detector finds a planted violation', () => {
    const planted = `await this.http({ path: '/auth/verify', query: { code }, method: 'POST' });`;
    const found = authRequestLiterals(planted);
    expect(found).toHaveLength(1);
    expect(CARRIES_QUERY.test(found[0]!)).toBe(true);
  });

  it('the detector survives a nested body without truncating', () => {
    const clean = `await this.http({ path: '/auth/login', method: 'POST', body: { email, password } });`;
    const found = authRequestLiterals(clean);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('password');
    expect(CARRIES_QUERY.test(found[0]!)).toBe(false);
  });

  it('does NOT count a declaration that merely names an auth path', () => {
    // The shape that made the first draft of this guard vacuous. `AUTH_RECORDINGS` is data about
    // the routes, not a call to one, and counting it hid the fact that no call site existed.
    const declaration = `export const T = [ { name: 'auth-login-invalid', path: '/auth/login', method: 'POST' } ];`;
    expect(authRequestLiterals(declaration)).toEqual([]);
  });

  it('actually found the auth call sites', () => {
    // Without this the guard passes by scanning nothing — the shape that let two other guards in
    // this repository stay green for their entire lives.
    expect(literals.length).toBeGreaterThanOrEqual(5);
  });

  it('none of them passes a query', () => {
    const offenders = literals.filter(({ lit }) => CARRIES_QUERY.test(lit)).map(({ f }) => f);
    expect(offenders).toEqual([]);
  });
});
