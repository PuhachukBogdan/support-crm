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
    for (const field of ['path', 'collection', 'params', 'required', 'pageSizeParam', 'pageTokenParam', 'ops', 'orderParam', 'orders']) {
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

  /**
   * I-4, AMENDED by feature 029.
   *
   * ⚠️ The original read *"no row declares a sort parameter — no consumed route accepts one"*. That
   * was a statement of FACT ABOUT THE SERVER, and the fact changed: `/conversations` now implements a
   * choice between two named orders. Deleting the guard would have been the easy move and the wrong
   * one — what it protects is still live, so it is rewritten to assert the new truth.
   *
   * What still holds, unchanged: no route accepts an arbitrary field `sort`, and a screen may only
   * offer an order the route declares.
   */
  it('no row declares a generic `sort` parameter — still no route that accepts one (I-4)', () => {
    for (const row of ROUTE_REGISTRY) {
      expect(Object.keys(row.params)).not.toContain('sort');
    }
  });

  it('I-4b: a row declaring orders declares them as a NON-EMPTY closed list with a parameter name', () => {
    for (const row of ROUTE_REGISTRY) {
      // Both or neither: an order parameter with no vocabulary would accept anything, and a
      // vocabulary with no parameter could never be sent.
      expect(Boolean(row.orders)).toBe(Boolean(row.orderParam));
      if (row.orders) {
        expect(row.orders.length).toBeGreaterThan(0);
        expect(new Set(row.orders).size).toBe(row.orders.length);
      }
    }
  });

  it('I-4c: `conversations` declares exactly the two orders the server implements', () => {
    const row = rowFor('conversations');
    expect(row.orderParam).toBe('order');
    expect([...row.orders!].sort()).toEqual(['updated_asc', 'updated_desc']);
  });

  it('⛔ I-4d: NO row offers an urgency/"recommended" order — nothing computes one (roadmap 4.20)', () => {
    // The sort control renders from this list, so an order named here is an order a person can pick.
    // A label asserting priority with nothing behind it is the one failure this screen must not ship:
    // unlike a broken filter, an agent working top-down cannot see that it is wrong.
    for (const row of ROUTE_REGISTRY) {
      for (const order of row.orders ?? []) {
        expect(order).not.toMatch(/recommend|priorit|urgen|smart|best/i);
      }
    }
  });

  it('the players row declares no order — it has none, and asking is refused client-side', () => {
    expect(rowFor('players').orders).toBeUndefined();
  });

  it('an unknown resource fails loudly rather than returning a default row', () => {
    expect(() => rowFor('not-a-resource')).toThrow(/not-a-resource/);
  });
});
