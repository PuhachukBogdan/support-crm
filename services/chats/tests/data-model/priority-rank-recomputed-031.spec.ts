import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T036 (feature 031, roadmap 4.19 — research R10) — **a rank whose input has moved is recomputed.**
 *
 * ── The hazard this guard exists for ────────────────────────────────────────────────────────────
 * A stored rank is a cached answer, and a cached answer nobody invalidates is the *confidently wrong
 * label* feature 029 refused to ship: the list is in an order, the order asserts urgency, and the
 * assertion stopped being true at some point nobody can identify by looking. R10 states the condition —
 * *"the plan must name what triggers recomputation and prove a stale rank is impossible"* — and this file
 * is the proof half.
 *
 * ── ⭐ How staleness is made IMPOSSIBLE rather than merely unlikely ──────────────────────────────
 * Two decisions together, and neither works alone:
 *
 *  1. **The stored rank's only input is the priority WORD.** Nothing about the clock is baked into it.
 *     The time half of urgency is read at query time from `updated_at`, a column that is by definition
 *     current — so there is no version of "the rank went stale because an hour passed". A rank that
 *     embedded age would need a sweep over 372 K rows to stay true, and would be wrong between sweeps.
 *  2. **The word and the rank are produced by ONE call** (`priorityWrite`), so a writer physically
 *     cannot set one and forget the other. This scan is what keeps decision 2 true as the code grows:
 *     it fails when a new path writes the column by hand.
 *
 * ── Dear implementer who just went red ─────────────────────────────────────────────────────────
 * Do not add your file to a list here — there is no list to add it to. Call `priorityWrite(value)` and
 * spread the result into your `data:` object. If your path genuinely must write the word without a rank,
 * that is a decision for the spec, not for this test.
 */

const SRC = join(__dirname, '..', '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !p.includes('generated'))
      out.push(p);
  }
  return out;
}

/** Comments first: the column is discussed in prose in several files, including this one. */
function strip(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function codeOf(file: string): string {
  return strip(readFileSync(file, 'utf8'));
}

/**
 * A WRITE of the priority word, by hand.
 *
 * ⚠️ Matched inside a `data:` object rather than anywhere the identifier appears. `priority:` as a bare
 * key is also how a filter, a wire mapping and an SLA policy scope are written — feature 031's first
 * version of the sanctioned-writers guard matched a column *mention* and reported a writer that did not
 * exist, which is how a guard teaches you to silence it.
 */
const HANDWRITTEN = /data:\s*\{[^}]*\bpriority:\s*(?!.*priority_rank)/s;

/** The one sanctioned producer of the pair. */
const THROUGH_HELPER = /priorityWrite\s*\(/;

describe('nothing writes the priority word without its rank (T036)', () => {
  const files = walk(SRC);

  it('the scan reads files at all — it is not vacuous', () => {
    // Two guards in feature 030 and one in 031 shipped matching zero files. This line is why they were
    // caught rather than passing for ever.
    expect(files.length).toBeGreaterThan(50);
  });

  it('⭐ every file that writes the priority column goes through `priorityWrite`', () => {
    const offenders = files
      .filter((f) => {
        const code = codeOf(f);
        return HANDWRITTEN.test(code) && !THROUGH_HELPER.test(code);
      })
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'));

    expect(offenders).toEqual([]);
  });

  it('⚠️ the detector fires on a planted hand-write, so the assertion above means something', () => {
    // Proven, not trusted: a regex that never matched would certify any codebase.
    expect(HANDWRITTEN.test('data: { priority: a.value }')).toBe(true);
    expect(HANDWRITTEN.test('data: { status: s, priority: input.priority ?? null }')).toBe(true);
    // …and it does NOT fire on the sanctioned spread, on a filter, or on prose.
    expect(HANDWRITTEN.test('data: { ...priorityWrite(a.value) }')).toBe(false);
    expect(HANDWRITTEN.test('where: { priority: f.priority }')).toBe(false);
    expect(strip('// data: { priority: x }\nconst a = 1;')).not.toMatch(HANDWRITTEN);
  });

  it('⛔ the two paths that DO set a priority are both present in the scan', () => {
    // Named so the guard cannot pass by the column having quietly stopped being written anywhere —
    // "no offenders" and "no writers" are the same result and very different facts.
    const writers = files
      .filter((f) => THROUGH_HELPER.test(codeOf(f)))
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'))
      .sort();
    expect(writers).toEqual(
      [
        // Creating a conversation with a priority (feature 012).
        'conversation/conversation.repository.ts',
        // ⭐ The macro / automation action applier — SET_PRIORITY. The writer a search for "the
        // conversation write path" misses, and the same shape as feature 023's fifth assignment writer.
        'automation/automations.repository.ts',
        // The helper itself.
        'conversation/urgency.ts',
      ].sort(),
    );
  });
});
