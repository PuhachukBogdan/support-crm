import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from '@crm/common';

/**
 * ⚠️ Brand scope is REMOVED, not switched off (ADR 0038 §1) — and this guard exists because removing
 * it took two attempts.
 *
 * There is ONE support department: the same people handle every brand in one queue, so a brand never
 * decides who may see what. Brand is part of a PLAYER'S IDENTITY (feature 020) and a FILTER a caller
 * may ask for. It is never a permission.
 *
 * ── Why a standing guard rather than "we deleted it" ─────────────────────────────────────────────
 *
 * Feature 020's cleanup removed the gateway's `x-actor-brands` sender, `ActorContext.brands` in
 * `chats` and its eight call sites — and **missed `services/users` entirely**. That service kept
 * reading the header and kept an intersection branch that could never fire, while roadmap 5.2 claimed
 * the machinery was gone. Spec helpers across two services also kept setting the header, so a grep
 * returned hits and read as a live control.
 *
 * The generalisable rule, third instance of the same shape in this product:
 *
 *   > A hunt for inert controls must enumerate SERVICES, not follow call chains out from wherever the
 *   > symptom was noticed.
 *
 * A permanently-unreachable authorization branch is worse than no branch: it reads as a live guarantee
 * to whoever comes next, and it is exactly where someone later adds a restriction nobody wants.
 *
 * ── ⚠️ COMMENTS ARE STRIPPED FIRST, and that is the whole subtlety ───────────────────────────────
 *
 * The removal is documented in place: `requires-permission.decorator.ts`, `permission.guard.ts`,
 * `actor-metadata.ts` and `player/actor.ts` each carry a retraction block that NAMES the removed
 * thing and says why it went. Those comments are the point — they stop the next reader re-adding it.
 * A guard that banned the token outright would force their deletion and destroy the record.
 *
 * So the detector is **strip comments, then match**, and the self-check below exercises that
 * PIPELINE. Testing the token list alone would prove the list is a list; testing the matcher alone
 * would prove a regex matches. Neither is the thing that has to work. (Recorded lesson: the
 * `no-direct-network` guard's first self-check tested the matcher while the detector was the
 * pipeline.)
 */

const ROOT = resolve(__dirname, '..', '..');
const ROOTS = ['services', 'libs'];

/** Generated output and dependencies are not ours to police. */
const SKIP_DIRS = new Set(['node_modules', 'generated', 'gen', 'dist', 'build', '.next']);

/**
 * Each token, and what its return would mean.
 *
 * `CheckBrandAccess` is deliberately ABSENT from this list: it survives in the proto marked
 * `deprecated` because removing an rpc trips `buf breaking`, and `hosting.spec.ts` asserts nothing
 * serves it. Banning a token that is legitimately present would make this guard a nuisance and invite
 * someone to widen it into uselessness.
 */
const FORBIDDEN: ReadonlyArray<{ token: string; meaning: string }> = [
  { token: 'x-actor-brands', meaning: 'the header carrying a caller-permitted brand set' },
  { token: 'mayAccessBrand', meaning: 'the per-brand access check' },
  { token: 'BrandAccessRule', meaning: 'the table that granted an operator read/answer on a brand' },
  { token: 'author_brands', meaning: "an automation author's brand scope at authoring time" },
  { token: 'RequiresBrandParam', meaning: 'the route decorator naming a brand param to authorize' },
  { token: 'REQUIRES_BRAND_PARAM_KEY', meaning: 'its metadata key' },
];

/**
 * The one legitimate reason for a token to appear in CODE: a test asserting the header is **not**
 * sent. Those two specs are the regression evidence for the removal itself — banning the token there
 * would delete the proof.
 *
 * ⚠️ Every exemption is itself checked below: if an allowed file stops containing the token, the
 * exemption is stale and this suite fails. A permanently-true exemption is the same disease as a
 * permanently-false authorization branch.
 */
const ALLOWED: ReadonlyArray<{ path: string; token: string; why: string }> = [
  {
    path: 'services/gateway/src/chats/actor-metadata.spec.ts',
    token: 'x-actor-brands',
    why: 'asserts the metadata builder emits NO brand header — the regression test for the removal',
  },
  {
    path: 'services/gateway/src/chats/feed.spec.ts',
    token: 'x-actor-brands',
    why: 'asserts the feed route forwards no brand header',
  },
];

function isAllowed(path: string, token: string): boolean {
  return ALLOWED.some((a) => a.path === path && a.token === token);
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts') || entry.endsWith('.proto') || entry.endsWith('.prisma'))
      yield full;
  }
}

/**
 * The detector, extracted so the self-check below can exercise the pipeline it actually is.
 *
 * `stripComments` moved to `@crm/common` an hour after this guard was written, when the feature-021
 * boundary guard failed on its own comments in exactly the same way. Two copies of a detector is one
 * copy that is wrong.
 */
export function findRemnants(source: string): string[] {
  const code = stripComments(source);
  return FORBIDDEN.filter((f) => code.includes(f.token)).map((f) => f.token);
}

describe('*** brand scope is gone from the CODE, not merely from the call graph (ADR 0038 §1) ***', () => {
  const files = ROOTS.flatMap((r) => [...walk(join(ROOT, r))]);
  const here = relative(ROOT, __filename);

  it('scans a non-trivial number of files — a guard over an empty set proves nothing', () => {
    // The vacuous-pass class this product has now hit seven times: a check that cannot fail is
    // indistinguishable from one that passes.
    expect(files.length).toBeGreaterThan(200);
  });

  it.each(FORBIDDEN)('no CODE mentions `$token` ($meaning)', ({ token }) => {
    const hits = files
      .filter((f) => relative(ROOT, f) !== here)
      .filter((f) => findRemnants(readFileSync(f, 'utf8')).includes(token))
      .map((f) => relative(ROOT, f).split(sep).join('/'))
      .filter((p) => !isAllowed(p, token));

    expect(hits).toEqual([]);
  });

  it.each(ALLOWED)('the exemption for $path is still needed ($why)', ({ path, token }) => {
    // A stale exemption is an exemption nobody re-examines. If the assertion it protects is deleted or
    // renamed, this fails and the entry gets removed rather than quietly outliving its reason.
    const src = readFileSync(join(ROOT, path), 'utf8');
    expect(findRemnants(src)).toContain(token);
  });

  describe('the detector can fail — proved on planted input, not asserted', () => {
    it('flags a token in code', () => {
      expect(findRemnants(`const md = { 'x-actor-brands': 'brand-a' };`)).toEqual(['x-actor-brands']);
      expect(findRemnants('if (mayAccessBrand(ctx, id)) return;')).toEqual(['mayAccessBrand']);
    });

    it('does NOT flag a token that only appears in a retraction comment', () => {
      // This is the case the guard exists to tolerate — and the one a regex-only detector gets wrong.
      expect(findRemnants('// x-actor-brands was removed by feature 020 (ADR 0038 §1).')).toEqual([]);
      expect(findRemnants('/** `mayAccessBrand` is gone; brand is not a permission. */')).toEqual([]);
    });

    it('does not lose a token to a `//` inside a string — the truncation a regex would cause', () => {
      expect(findRemnants(`const u = 'https://x/y'; const h = 'x-actor-brands';`)).toEqual([
        'x-actor-brands',
      ]);
    });

    it('finds nothing in ordinary source', () => {
      expect(findRemnants('export const brandId = req.brandId;')).toEqual([]);
    });
  });
});
