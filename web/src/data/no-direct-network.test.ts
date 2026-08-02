import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T008 [US1] — SC-006: no UI file may reach the network directly. Everything goes through the
 * DataAccess interface.
 *
 * ⚠️ This guard was VACUOUS from the day it was written (found 2026-07-29, before the real
 * transport existed). It asserted exactly one thing: that nothing under `components/` imports
 * from `src/api/**` — a directory that has NEVER existed in this repository (`git log
 * --diff-filter=A --all -- 'web/src/api/*'` is empty). It therefore could not fail, while its
 * own header claimed the much stronger "no component may reach the network directly". A
 * component calling `fetch()` passed it. Fourth instance of the class already tracked as
 * `gotchas/vacuous-pass-in-live-scripts`.
 *
 * Three changes, each aimed at one way the old shape failed:
 *   1. It scans for the CALL, not for an import path — that is the behaviour SC-006 names, and
 *      it does not depend on where the transport happens to live.
 *   2. It covers `app/` as well as `components/`. A route file is a component too, and the
 *      original scope left the whole App Router unguarded.
 *   3. It proves its own detector against known-bad samples and asserts it actually read files.
 *      A structural guard that never demonstrates a positive is indistinguishable from one that
 *      matches nothing — which is precisely how this test spent its whole life green.
 */

/**
 * T008 [027] — `session/` joins the scanned roots.
 *
 * The auth pages under `app/` were already covered (the whole App Router is a root), so the
 * genuine extension is the layer this feature adds beneath them: the session boundary talks to the
 * gateway, and it must do so through the INJECTED port like everything else. If it reached for
 * `fetch` directly it would be a second network path — and the whole argument for widening one
 * port instead of adding a second (research §1) is that this guard keeps covering every path.
 *
 * `src/data/gateway/http-port.ts` is deliberately NOT a root: it is the one adapter that may call
 * `fetch`, which is the entire reason it exists.
 */
const UI_ROOTS = [
  join(__dirname, '..', 'components'),
  join(__dirname, '..', 'session'),
  join(__dirname, '..', '..', 'app'),
];

/** Pages whose coverage is asserted by name — a renamed folder must not silently unguard them. */
const MUST_BE_COVERED = [
  join('app', '(auth)', 'login', 'page.tsx'),
  join('app', '(auth)', 'register', 'page.tsx'),
  join('src', 'session', 'gateway-session.ts'),
];

/** Direct network primitives. Word-anchored, so `prefetch`/`refetch` are not false positives. */
const NETWORK_CALL =
  /\bfetch\s*\(|\bnew\s+(WebSocket|XMLHttpRequest|EventSource)\b|from\s+['"]axios['"]/;

/** Transport-layer imports: a component must not reach past the interface either. */
const TRANSPORT_IMPORT = /from\s+['"](@\/api(\/|['"])|(\.\.?\/)+api\/)/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Comments are stripped: prose about the future gateway must not read as a call to it. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

describe('structure guard — UI never reaches the network directly (SC-006)', () => {
  const files = UI_ROOTS.flatMap(walk);

  it('the detector matches a real offender (this guard is not vacuous)', () => {
    expect(NETWORK_CALL.test("const r = await fetch('/api/records');")).toBe(true);
    expect(NETWORK_CALL.test("const ws = new WebSocket('wss://x');")).toBe(true);
    expect(NETWORK_CALL.test("import axios from 'axios';")).toBe(true);
    expect(TRANSPORT_IMPORT.test("import { http } from '@/api/client';")).toBe(true);

    // …and does not fire on the shapes that legitimately look similar.
    expect(NETWORK_CALL.test('const { refetch } = useRecords();')).toBe(false);
    expect(NETWORK_CALL.test('<Link prefetch={false} href="/x" />')).toBe(false);
  });

  it('actually scanned the UI tree', () => {
    // Without this, emptying or renaming a folder turns the guard off silently.
    expect(files.length).toBeGreaterThan(10);
  });

  it('covers the auth pages and the session boundary by name', () => {
    // "The guard covers them" is a claim about a file list, so it is asserted against the file
    // list. A route group renamed from `(auth)` to something else would otherwise drop the two
    // pages that handle a password out of the scan, with every test still green.
    const missing = MUST_BE_COVERED.filter((suffix) => !files.some((f) => f.endsWith(suffix)));
    expect(missing).toEqual([]);
  });

  it('no UI file calls fetch / WebSocket / XHR / axios directly', () => {
    const offenders = files.filter((f) => NETWORK_CALL.test(codeOf(f)));
    expect(offenders).toEqual([]);
  });

  it('no UI file imports the transport layer', () => {
    const offenders = files.filter((f) => TRANSPORT_IMPORT.test(codeOf(f)));
    expect(offenders).toEqual([]);
  });
});
