import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { FIELD_TIERS, type FieldTier } from '../../libs/common/src/policy/field-tiers';

/**
 * T046a (feature 018, roadmap 5.1) — FR-007: **one masking function, one tier map, no per-operation
 * tier branch.**
 *
 * ── Why this is a test and not a code-review habit ───────────────────────────────────────────────
 * Feature 011 shipped **two** audit stores. Not because anyone decided to; because the second surface
 * that needed one found writing a fresh table easier than routing through the existing writer, and
 * nothing failed. Feature 015 then had to migrate 29 live rows out of that mistake. This feature adds
 * three read surfaces to a policy that already existed, which is exactly the moment that shape recurs
 * — the list handler is the obvious place for a "slightly different" masking pass.
 *
 * ── The specific failure being prevented ─────────────────────────────────────────────────────────
 * A second masking function is not a duplicate-code smell, it is a **security divergence with a delay
 * fuse**: two allow-lists agree on the day they are written and disagree the first time one is updated.
 * The one that was forgotten keeps serving the field somebody decided to withhold, and no test fails
 * because both were tested — separately.
 */
const ROOT = resolve(__dirname, '..', '..');

/** Where policy definitions are permitted to live. Anything else is a second copy. */
const POLICY_HOME = 'libs/common/src/policy/field-tiers.ts';
const MASKING_HOME = 'services/users/src/player/player.masking.ts';
/** The one place that ranks tiers to pick the most sensitive one for an audit entry (not a classification). */
const RANKING_HOME = 'services/users/src/player/contact-view-audit.service.ts';
/**
 * ⭐ W35 / feature 040 — the one consumer of the notes GATE.
 *
 * Player notes are the first thing whose visibility is the `am_only` question asked about a TABLE rather
 * than about fields of a row: a note cannot be masked out of a projection, it is served or refused. So
 * the decision is a gate (`assertCanReadPlayerNotes`, defined in {@link MASKING_HOME}) — and this
 * constant pins that the gate has exactly ONE caller. A second caller is not automatically wrong; it is
 * a decision, and it should have to edit this line to happen.
 */
const NOTES_GATE_CONSUMER = 'services/users/src/player/player-note.service.ts';

const SCAN_ROOTS = ['libs/common/src', 'libs/proto/crm', 'services'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'gen' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|proto)$/.test(entry) && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/** Repo-relative, forward-slashed. */
const rel = (abs: string): string => abs.slice(ROOT.length + 1).split(sep).join('/');

/** Strip comments so every scan below sees code, not prose about code. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*(\/\/|#).*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

const SOURCES = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, ...r.split('/')))).map((abs) => ({
  path: rel(abs),
  code: code(readFileSync(abs, 'utf8')),
}));

describe('the scan sees the product (nothing below can pass by scanning nothing)', () => {
  it('reaches all three services that matter plus the shared lib', () => {
    expect(SOURCES.length).toBeGreaterThan(150);
    for (const expected of [POLICY_HOME, MASKING_HOME, RANKING_HOME]) {
      expect(SOURCES.map((s) => s.path)).toContain(expected);
    }
  });

  it('the comment stripper does not swallow code, and does not keep prose', () => {
    expect(code('const a = 1; // maskPlayer')).toContain('const a = 1;');
    expect(code('const a = 1; // maskPlayer')).not.toContain('maskPlayer');
    expect(code('/** maskPlayer lives elsewhere */ const b = 2;')).not.toContain('maskPlayer');
    // A URL must survive: `//` inside a string is not a comment.
    expect(code("const u = 'https://x.test/a';")).toContain('https://x.test/a');
  });
});

describe('*** exactly ONE masking function exists ***', () => {
  it('maskPlayer is defined once, in the owning service', () => {
    const definers = SOURCES.filter((s) => /\b(function|const)\s+maskPlayer\b/.test(s.code)).map(
      (s) => s.path,
    );
    expect(definers).toEqual([MASKING_HOME]);
  });

  it('no second function shapes a player by role under another name', () => {
    // The rename escape hatch: `maskPlayerFields`, `filterPlayerForRole`, `visibleFieldsFor`… A second
    // implementation is a second allow-list whatever it is called.
    const suspects = SOURCES.filter((s) => s.path !== MASKING_HOME).filter((s) =>
      /\b(function|const)\s+\w*(?:[Mm]ask|[Ff]ilter|[Rr]edact|[Ss]anitize)\w*(?:Player|Contact|Customer)\w*\b/.test(
        s.code,
      ),
    );
    expect(suspects.map((s) => s.path)).toEqual([]);
  });

  it('the mass-export gate is also defined once', () => {
    const definers = SOURCES.filter((s) =>
      /\b(function|const)\s+assertCanMassExport\b/.test(s.code),
    ).map((s) => s.path);
    expect(definers).toEqual([MASKING_HOME]);
  });
});

describe('*** exactly ONE tier map exists ***', () => {
  it('FIELD_TIERS and ROLE_VISIBLE_TIERS are declared only in the shared policy', () => {
    for (const symbol of ['FIELD_TIERS', 'ROLE_VISIBLE_TIERS']) {
      const definers = SOURCES.filter((s) =>
        new RegExp(`\\b(?:const|let|var|enum)\\s+${symbol}\\b`).test(s.code),
      ).map((s) => s.path);
      expect({ symbol, definers }).toEqual({ symbol, definers: [POLICY_HOME] });
    }
  });

  /**
   * ⚠️ `open` is EXCLUDED from this scan, and the reason is worth stating rather than hiding in a filter:
   * it is also a **ticket-status word** in the chats domain, so scanning for it reports that domain as a
   * tier-policy violation. That is noise, not signal, and a scan that cries wolf gets its expectation
   * widened by the next person until it asserts nothing.
   *
   * ⭐ **The collision MOVED in feature 032 (roadmap 4.16) and the assertion below moved with it.** It
   * used to live in `services/chats/src/shared/wire.ts` as one member of a four-value enum
   * (`'open' | 'pending' | 'resolved' | 'snoozed'`). Statuses are per-account rows now, and the only
   * status word left in code is the CATEGORY catalogue — where `open` is a category key. The exclusion is
   * still justified; the file that justifies it is a different one, and pinning the new file is what keeps
   * "excluded for a collision" from decaying into "excluded because it was inconvenient".
   *
   * The three remaining names are unambiguous and sufficient: a second classification of customer fields
   * has to name the tiers it distinguishes, and `open` alone distinguishes nothing — a map containing only
   * `open` cannot mask anything.
   */
  const DISTINCTIVE_TIERS: readonly FieldTier[] = ['operational', 'am_only', 'masked_pii'];

  it('the excluded name is exactly `open`, and it is excluded for a collision (not convenience)', () => {
    const all = [...new Set(Object.values(FIELD_TIERS))].sort();
    expect(all).toEqual(['am_only', 'masked_pii', 'open', 'operational']);
    expect([...DISTINCTIVE_TIERS].sort()).toEqual(['am_only', 'masked_pii', 'operational']);
    // The collision itself, asserted so the exclusion stops being justified if it ever disappears.
    const statusCategories = SOURCES.find(
      (s) => s.path === 'libs/common/src/statuses/categories.ts',
    );
    expect(statusCategories?.code).toMatch(/['"`]open['"`]/);
    // …and the file it USED to live in no longer contains the word at all, which is the other half of
    // feature 032: the four-value status vocabulary was deleted rather than deprecated in place.
    const chatsWire = SOURCES.find((s) => s.path === 'services/chats/src/shared/wire.ts');
    expect(chatsWire?.code).not.toMatch(/['"`]open['"`]/);
  });

  it('no other file writes a distinctive tier NAME in code — the vocabulary has one home', () => {
    // The realistic second copy is not a copied file, it is a helper with `if (tier === 'am_only')` in
    // it. Tier names appearing in code outside the policy (and its one ranking consumer) is that shape.
    const pattern = new RegExp(`['"\`](?:${DISTINCTIVE_TIERS.join('|')})['"\`]`);
    const offenders = SOURCES.filter(
      (s) => s.path !== POLICY_HOME && s.path !== RANKING_HOME && pattern.test(s.code),
    ).map((s) => s.path);
    expect(offenders).toEqual([]);
  });

  it('the one permitted tier-name consumer only RANKS them, and covers the full vocabulary', () => {
    const ranking = SOURCES.find((s) => s.path === RANKING_HOME)!;
    // It may order tiers; it may not decide which FIELDS belong to them.
    expect(ranking.code).toMatch(/TIER_RANK/);
    expect(ranking.code).not.toMatch(/\bam_notes\b|\bpreferences\b|\bportfolio\b|\bgr8_snapshot\b/);
    // Typed as Record<FieldTier, …>, so a new tier is a compile error rather than a silent rank of 0 —
    // asserted here because the consequence (an unranked tier losing to every other) is invisible.
    expect(ranking.code).toMatch(/Record<\s*FieldTier\s*,/);
  });

  it('the tier-name predicate actually fires (so the emptiness above means something)', () => {
    const pattern = new RegExp(`['"\`](?:${DISTINCTIVE_TIERS.join('|')})['"\`]`);
    expect(pattern.test("if (tier === 'am_only') return true;")).toBe(true);
    expect(pattern.test("const tiers = ['operational'];")).toBe(true);
    expect(pattern.test('const x = 1;')).toBe(false);
    // …and does not fire on the excluded collision, which is what makes the scan quiet enough to keep.
    expect(pattern.test("if (status === 'open') return;")).toBe(false);
  });
});

describe('*** clearance is computed in ONE place ***', () => {
  it('only the masking module and the audit writer consult the policy helpers', () => {
    // `allowedFields` decides what a role may see; `surfacedMaskableTiers` decides what gets recorded. A
    // third consumer means a third opinion, which is how the two-audit-store mistake happened.
    const consumers = SOURCES.filter((s) =>
      /\ballowedFields\s*\(|\bvisibleTiersFor\s*\(|\bsurfacedMaskableTiers\s*\(/.test(s.code),
    ).map((s) => s.path);
    expect(consumers.sort()).toEqual([POLICY_HOME, RANKING_HOME, MASKING_HOME].sort());
  });

  /**
   * ⭐ W35 / feature 040. The derived predicate the notes gate stands on may be consulted only where the
   * other clearance arithmetic is: the policy that owns the vocabulary, and the masking module that owns
   * *"what may this role see"*. A notes service that called it directly would be computing clearance in
   * a third place — the shape this whole file exists to forbid — even though it would produce the same
   * answer on the day it was written.
   */
  it('the notes predicate is consulted only by the policy and the masking module', () => {
    const consumers = SOURCES.filter((s) => /\bseesAmOnlyTier\s*\(/.test(s.code)).map((s) => s.path);
    expect(consumers.sort()).toEqual([POLICY_HOME, MASKING_HOME].sort());
  });

  it('the notes GATE is defined in the masking module and called from exactly one place', () => {
    const definers = SOURCES.filter((s) =>
      /\b(?:function|const)\s+(?:assert)?[Cc]anReadPlayerNotes\b/.test(s.code),
    ).map((s) => s.path);
    expect(definers).toEqual([MASKING_HOME]);

    const callers = SOURCES.filter(
      (s) => s.path !== MASKING_HOME && /\bassertCanReadPlayerNotes\s*\(/.test(s.code),
    ).map((s) => s.path);
    expect(callers).toEqual([NOTES_GATE_CONSUMER]);
  });

  it('the gateway edge holds no field policy at all', () => {
    // The masking decision belongs to the service that owns the data (Principle II's division of labour):
    // the edge authorizes the CALL, the owner shapes the ROW. An edge that also masked would be a second
    // policy in the place least able to know the record.
    const gateway = SOURCES.filter((s) => s.path.startsWith('services/gateway/'));
    expect(gateway.length).toBeGreaterThan(20);
    for (const file of gateway) {
      expect({
        path: file.path,
        holdsPolicy: /allowedFields|visibleTiersFor|FIELD_TIERS|maskPlayer/.test(file.code),
      }).toEqual({ path: file.path, holdsPolicy: false });
    }
  });
});

describe('*** no per-operation tier branch *** (the same policy for one record and for a page)', () => {
  const controller = SOURCES.find(
    (s) => s.path === 'services/users/src/player/player.grpc.controller.ts',
  )!;

  it('both read handlers mask through the same function', () => {
    const calls = controller.code.match(/maskPlayer\s*\(/g) ?? [];
    // One in GetPlayer, one inside the list's row mapping. Two call sites, one implementation.
    expect(calls.length).toBe(2);
  });

  it('every masking call passes the ACTOR role — never a literal, never an operation-specific value', () => {
    // `maskPlayer(row, 'am')` or `maskPlayer(row, isList ? x : y)` would be a per-operation policy wearing
    // the shared function's clothes: same call, different answer, no test failing.
    const calls = [
      ...controller.code.matchAll(/maskPlayer\s*\(([\s\S]*?)\)\s*[,;)]/g),
    ].map((m) => m[1]!.replace(/\s+/g, ' ').trim());
    expect(calls.length).toBe(2);
    for (const args of calls) {
      expect(args).toContain('actor.effectiveRole');
      expect(args).not.toMatch(/['"`]/);
    }
  });

  it('the list does not narrow or widen the page rows beyond masking', () => {
    // A `delete row.x` or a hand-picked subset in the list path would be exactly the divergence: the page
    // and the single read answering differently about the same record.
    expect(controller.code).not.toMatch(/\bdelete\s+\w+\.\w+/);
  });

  it('the bulk guard is consulted in the list path and nowhere reimplemented', () => {
    expect(controller.code).toMatch(/assertCanMassExport\s*\(\s*actor\.effectiveRole\s*\)/);
    // Not re-derived from permissions: SEC-AP2 is a TIER question, and a role holding every permission key
    // with open-only clearance must still be refused.
    expect(controller.code).not.toMatch(/permissions\.(?:includes|has)\([^)]*read_pii/);
  });
});
