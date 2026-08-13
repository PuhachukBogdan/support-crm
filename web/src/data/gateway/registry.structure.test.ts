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
    // W7 added `verbs` (write verbs) and `singleton`/`{within}` handling — still row facts, read
    // the same way. If a verb or a path shape ever appears as a constant here, this list is where
    // the omission shows.
    for (const field of ['path', 'collection', 'params', 'required', 'pageSizeParam', 'pageTokenParam', 'ops', 'orderParam', 'orders', 'verbs', 'singleton', 'itemSuffix']) {
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

  it('W7: a child row carries `{within}` as one whole path segment, never a fragment', () => {
    // The transport substitutes it with `.replace` once; a second occurrence would survive into the
    // URL, and a fragment (`/x{within}y/`) would splice an id into a word. Both are unbuildable
    // while this holds.
    for (const row of ROUTE_REGISTRY) {
      const hits = row.path.match(/\{within\}/g) ?? [];
      expect(hits.length).toBeLessThanOrEqual(1);
      if (hits.length === 1) expect(row.path).toMatch(/\/\{within\}(\/|$)/);
    }
  });

  it('W7/W8: write verbs, where declared, come from the closed set the gateway uses', () => {
    for (const row of ROUTE_REGISTRY) {
      if (row.verbs?.update) expect(['PATCH', 'PUT', 'POST']).toContain(row.verbs.update);
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

  it('I-4c: `conversations` declares exactly the orders the server implements', () => {
    const row = rowFor('conversations');
    expect(row.orderParam).toBe('order');
    // ⭐ Three since feature 031 (roadmap 4.19): the urgency order the server now genuinely has.
    expect([...row.orders!].sort()).toEqual(['updated_asc', 'updated_desc', 'urgency_desc']);
  });

  it('⛔ I-4d: no order promises a JUDGEMENT nothing makes', () => {
    // The sort control renders from this list, so an order named here is an order a person can pick, and a
    // label asserting something with nothing behind it is the one failure this screen must not ship:
    // unlike a broken filter, an agent working top-down cannot see that it is wrong.
    //
    // ⚠️ This assertion CHANGED with feature 031 and the change is the interesting part. It used to forbid
    // `urgen|priorit` as well, because nothing computed urgency. A maintained rank now exists, so an order
    // may sort BY a stated key — what stays forbidden is a name implying a recommendation, a model or a
    // "best": those describe a judgement, and no code in this product makes one.
    for (const row of ROUTE_REGISTRY) {
      for (const order of row.orders ?? []) {
        expect(order).not.toMatch(/recommend|smart|best|ai/i);
      }
    }
  });

  it('⭐ I-4e: an order that CLAIMS urgency is only allowed because the server maintains a rank', () => {
    // The one such order is `urgency_desc`, and the receipt for it is `Conversation.priority_rank` plus the
    // structural guard in chats that fails when the word is written without its rank. If a future order
    // matching this pattern appears, that receipt is what it needs — not an entry here.
    const claiming = ROUTE_REGISTRY.flatMap((r) => (r.orders ?? []).filter((o) => /urgen|priorit/i.test(o)));
    expect(claiming).toEqual(['urgency_desc']);
  });

  it('the players row declares no order — it has none, and asking is refused client-side', () => {
    expect(rowFor('players').orders).toBeUndefined();
  });

  it('an unknown resource fails loudly rather than returning a default row', () => {
    expect(() => rowFor('not-a-resource')).toThrow(/not-a-resource/);
  });
});
