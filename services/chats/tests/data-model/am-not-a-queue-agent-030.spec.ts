import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_VISIBLE_TIERS } from '@crm/common';

/**
 * T021–T024 (feature 030, FR-010…FR-013) — **the AM is not a queue agent.**
 *
 * Scope brief §4/§9.1: no round-robin distribution, no capacity-based auto-assignment and no queue SLA
 * pressure on an AM's attached-player tickets. The portfolio stays the AM's primary mode.
 *
 * ⚠️ **This is asserted STRUCTURALLY, and it has to be**, because the code it constrains does not exist
 * yet: push routing is roadmap **4.20** and per-channel capacity is **4.21**. A test of an output with no
 * producer passes for the wrong reason — the vacuous-pass shape this project has hit five times. So the
 * assertion is over the *absence of a path*, written to still hold, and to FAIL, when 4.20/4.21 land.
 *
 * ⚠️ **It must not become an exemption list.** Assignment BY A PERSON stays allowed (FR-005's write half:
 * the door opens from the inside); what is forbidden is the MACHINE choosing an AM. The two are
 * distinguished below by where the role appears, not by naming call sites.
 *
 * ── Dear implementer of 4.20 / 4.21 ─────────────────────────────────────────────────────────────
 * If this file went red for you: the rule is that a candidate pool for automatic distribution may not be
 * built from, or filtered to, the roles that see `am_only` without `masked_pii`. Route to a queue role and
 * let an AM be handed work explicitly. Do not add your file to an allow-list here — change the pool.
 */

const SRC = join(__dirname, '..', '..', 'src');

/** The roles this rule protects, DERIVED — never a literal `['am','shift_am']` that would drift. */
const AM_ROLES = Object.entries(ROLE_VISIBLE_TIERS)
  .filter(([, tiers]) => tiers.includes('am_only') && !tiers.includes('masked_pii'))
  .map(([role]) => role);

/** Every `.ts` under `dir`, recursively — the same walk the no-PII-logs guard uses. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

/** Comments are stripped first: a rule named in prose must not read as a violation. */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the AM is not fed by the queue machinery (FR-010…FR-013)', () => {
  it('the protected role set is derived and non-empty', () => {
    // Positive control on the fixture: an empty set would satisfy every assertion below.
    expect(AM_ROLES).toContain('am');
    expect(AM_ROLES).toContain('shift_am');
    expect(AM_ROLES).not.toContain('admin');
  });

  it('⭐ no distribution or capacity module names an AM role at all', () => {
    // Naming the role in the routing layer is the tell. A pool that must exclude AMs by listing them is
    // one config change from including them again; a pool built from queue roles cannot reach an AM.
    const files = walk(SRC).filter(
      (f) =>
        /assignment|automation|routing|capacity/i.test(f) &&
        // This feature's own module legitimately reasons about the AM clearance — that is the narrowing,
        // not the distribution. Excluded by NAME so the exclusion cannot silently grow.
        !/portfolio-scope\.ts$/.test(f),
    );
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const code = codeOf(file);
      for (const role of AM_ROLES) {
        if (new RegExp(`['"\`]${role}['"\`]`).test(code)) offenders.push(`${file}: ${role}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('⚠️ the SLA layer does not branch on an AM role either (FR-012)', () => {
    // A queue timer applied to a portfolio conversation is queue pressure by another name. The VIP
    // one-minute rule is roadmap 4.11 and is NOT this: it is a different clock, deliberately out of scope.
    const files = walk(join(SRC, 'sla'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const code = codeOf(file);
      for (const role of AM_ROLES) {
        expect(code).not.toMatch(new RegExp(`['"\`]${role}['"\`]`));
      }
    }
  });
});
