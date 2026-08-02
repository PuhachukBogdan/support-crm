import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * T039 [027] — **no module exports a session that authenticates without the network** (FR-021).
 *
 * ── Why deleting `mock-session.ts` was not enough ───────────────────────────────────────────────
 * A mock left reachable in the tree is one import away from being live. The deleted one was a
 * `Session` whose `isAuthenticated()` read a flag out of `localStorage` — three lines, no network,
 * and it was wired into the app for months by a single module-level assignment. Re-adding it would
 * be an afternoon's work by somebody trying to make a test easier, and nothing would object.
 *
 * So the guarantee is structural: **exactly one** implementation of `Session` exists in the
 * application tree, and it is the one that asks the gateway.
 *
 * ⓘ Test files are excluded. A double inside a `.test.ts` cannot be imported by the product, and
 * banning them would push tests towards stubbing the network globally instead — which is worse.
 */

const ROOTS = [join(__dirname, '..'), join(__dirname, '..', '..', 'app')];
const WEB_ROOT = join(__dirname, '..', '..');

/** The one file allowed to implement the boundary. */
const THE_IMPLEMENTATION = join('src', 'session', 'gateway-session.ts');

/** Names that announce a session double, whatever the file is called. */
const DOUBLE_NAME = /\b(mock|fake|stub|demo|dummy|offline|local)[A-Za-z]*session\b/i;

/** Evidence that an implementation actually goes to the network. */
const USES_TRANSPORT = /HttpPort|createFetchPort|this\.http\s*\(/;

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
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

const IMPLEMENTS_SESSION = /\bimplements\s+Session\b/;

describe('structure guard — only one session, and it asks the gateway (FR-021)', () => {
  const files = ROOTS.flatMap(walk);
  const sources = files.map((f) => ({ file: relative(WEB_ROOT, f), code: codeOf(f) }));

  it('the detector recognises the shape that was deleted', () => {
    const planted = `export class MockSession implements Session {\n  state() { return { kind: 'authenticated' }; }\n}`;
    expect(IMPLEMENTS_SESSION.test(planted)).toBe(true);
    expect(DOUBLE_NAME.test(planted)).toBe(true);
    expect(USES_TRANSPORT.test(planted)).toBe(false);
  });

  it('the detector does not fire on the real implementation', () => {
    const real = `export class GatewaySession implements Session {\n  constructor(private readonly http: HttpPort) {}\n}`;
    expect(DOUBLE_NAME.test(real)).toBe(false);
    expect(USES_TRANSPORT.test(real)).toBe(true);
  });

  it('actually scanned the application tree', () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it('⭐ exactly one file implements the session boundary', () => {
    // Not "at most one": zero would mean the scan lost the tree, and this guard would then be
    // green for the rest of its life while guarding nothing.
    const implementors = sources.filter((s) => IMPLEMENTS_SESSION.test(s.code)).map((s) => s.file);
    expect(implementors).toEqual([THE_IMPLEMENTATION]);
  });

  it('that implementation reaches the gateway rather than deciding for itself', () => {
    const impl = sources.find((s) => s.file === THE_IMPLEMENTATION);
    expect(impl).toBeDefined();
    expect(USES_TRANSPORT.test(impl!.code)).toBe(true);
  });

  it('nothing in the tree is named like a session double', () => {
    const offenders = sources.filter((s) => DOUBLE_NAME.test(s.code)).map((s) => s.file);
    expect(offenders).toEqual([]);
  });

  it('the deleted mock’s storage key is gone with it', () => {
    // The flag it wrote was `crm.demo.session`. A leftover reference means something still reads
    // it — and a session that can be granted by writing a string into `localStorage` is not one.
    const offenders = sources.filter((s) => s.code.includes('crm.demo.session')).map((s) => s.file);
    expect(offenders).toEqual([]);
  });
});
