import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_REGISTRY, rowFor } from './registry';

/**
 * T030 [Polish] — FR-003 / data-model I-1: **adding a resource is adding a ROW.**
 *
 * The operator's constraint for this feature was that later work must ADD to it rather than rewrite
 * it. That is only true while the transport branches on nothing: the moment one `if (resource === …)`
 * appears, the next resource is an edit to control flow, and the one after that is a rewrite.
 *
 * Same discipline as the closed-and-additive catalogues of 011 permissions / 014 automation
 * vocabulary / 015 audit actions / 016 upload purposes / 017 export scopes, each guarded by a test
 * asserting nothing branches on a member name.
 *
 * ⚠️ The detector proves itself against known-bad samples first. A structural guard that never
 * demonstrates a positive is indistinguishable from one that matches nothing — which is exactly how
 * `no-direct-network.test.ts` spent its whole life green (found 2026-07-29, fourth instance).
 */

const TRANSPORT = join(__dirname, 'gateway-data-access.ts');

/** Comments stripped: prose naming a resource must not read as a branch on one. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

const RESOURCE_NAMES = ROUTE_REGISTRY.map((r) => r.resource);

/** A literal resource name appearing anywhere in the transport's logic. */
function branchesOnResource(code: string): string[] {
  return RESOURCE_NAMES.filter((name) =>
    new RegExp(`['"\`]${name}['"\`]`).test(code),
  );
}

describe('the detector is not vacuous', () => {
  it('fires on a resource name written into logic', () => {
    expect(branchesOnResource(`if (resource === '${RESOURCE_NAMES[0]}') return special();`)).toEqual(
      [RESOURCE_NAMES[0]],
    );
    expect(branchesOnResource(`switch (r) { case "${RESOURCE_NAMES[1]}": break; }`)).toEqual([
      RESOURCE_NAMES[1],
    ]);
  });

  it('does not fire on code that merely uses the row', () => {
    expect(branchesOnResource('const row = rowFor(resource); return row.path;')).toEqual([]);
  });

  it('and there are resource names to look for', () => {
    // Without this, an empty registry would make the guard pass by having nothing to find.
    expect(RESOURCE_NAMES.length).toBeGreaterThan(1);
  });
});

describe('*** the transport branches on no resource ***', () => {
  it('contains no literal resource name', () => {
    expect(branchesOnResource(codeOf(TRANSPORT))).toEqual([]);
  });

  it('contains no switch statement at all', () => {
    // A switch on anything else would be fine; there is none, and saying so keeps the next reader
    // from adding the first one on a resource.
    expect(codeOf(TRANSPORT)).not.toMatch(/\bswitch\s*\(/);
  });

  it('reads every route fact from the row rather than from a constant', () => {
    const code = codeOf(TRANSPORT);
    for (const field of ['path', 'collection', 'params', 'required', 'pageSizeParam', 'pageTokenParam', 'ops']) {
      expect(code).toContain(`row.${field}`);
    }
  });
});

describe('the registry is well formed', () => {
  it('resource names are unique', () => {
    expect(new Set(RESOURCE_NAMES).size).toBe(RESOURCE_NAMES.length);
  });

  it('every required key is one the row actually accepts', () => {
    // Otherwise a row could demand a parameter it has no way to send — refusing every call to that
    // resource, with a message naming a key that does not exist.
    for (const row of ROUTE_REGISTRY) {
      for (const key of row.required) expect(Object.keys(row.params)).toContain(key);
    }
  });

  it('every path is relative, with no host and no query', () => {
    for (const row of ROUTE_REGISTRY) {
      expect(row.path.startsWith('/')).toBe(true);
      expect(row.path).not.toMatch(/^https?:|[?&]/);
    }
  });

  it('no row declares a sort parameter — no consumed route accepts one (I-4)', () => {
    for (const row of ROUTE_REGISTRY) {
      expect(Object.keys(row.params)).not.toContain('sort');
    }
  });

  it('an unknown resource fails loudly rather than returning a default row', () => {
    expect(() => rowFor('not-a-resource')).toThrow(/not-a-resource/);
  });
});
