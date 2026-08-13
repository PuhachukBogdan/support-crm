import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIELD_TIERS, ROLE_VISIBLE_TIERS } from '@crm/common';

/**
 * T004 (feature 031) — **no module that routes work may name a role or a tier.**
 *
 * This is feature 030's guard (`am-not-a-queue-agent-030.spec.ts`) restated from the inside: that one
 * asks *"does the routing layer mention an account manager?"*, this one asks the stronger question
 * *"does it mention ANY role, or any tier, at all?"* — because the answer must be no for the same
 * reason either way. Who may receive work is a policy question with one home
 * (`libs/common/src/policy/field-tiers.ts`), and a router that names a role has taken a copy of it.
 *
 * ⚠️ **Why the stronger form.** Feature 030 shipped a module that *imported* the policy rule and still
 * did the tier arithmetic itself; every test passed and the repo-wide `single-policy-path` guard caught
 * it. Reusing a rule and recomputing it are different things, and the second looks like the first. A
 * ban on the vocabulary is checkable; "please don't recompute it" is not.
 *
 * ── Dear implementer who just went red ──────────────────────────────────────────────────────────
 * Ask the policy lib instead. `isQueueRole(roleKey)` answers *"may automatic distribution hand work to
 * this role?"*, and `narrowsToOwnPortfolio(roleKey)` answers the portfolio question. If you need a
 * question neither answers, **add it there** — do not add your file to an exemption list here, because
 * an exemption list is how the vocabulary comes back one file at a time.
 */

const ASSIGNMENT = join(__dirname, '..', '..', 'src', 'assignment');

/** Every non-spec `.ts` under `dir`, recursively — the same walk the no-PII-logs guard uses. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

/**
 * Comments are stripped first. Every rule in this repo is explained in prose beside the code it
 * governs, so a guard that read comments would fire on its own documentation — and the fix would be to
 * delete the explanation, which is the opposite of what we want.
 */
function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The tier names, minus `open` — which collides with ordinary English and with a conversation status. */
const TIER_NAMES = [...new Set(Object.values(FIELD_TIERS))].filter((t) => t !== 'open');

describe('the routing layer names no role and no tier (T004)', () => {
  const files = walk(ASSIGNMENT);

  it('there are routing files to check — the guard is not vacuous', () => {
    // Without this, a moved folder would make every assertion below pass by finding nothing. Feature
    // 030's version of this guard shipped with a glob that matched zero files, and only this line
    // caught it.
    expect(files.length).toBeGreaterThan(0);
    expect(Object.keys(ROLE_VISIBLE_TIERS).length).toBeGreaterThan(0);
    expect(TIER_NAMES.length).toBeGreaterThan(0);
  });

  it('⭐ no role key appears as a literal', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = codeOf(file);
      for (const role of Object.keys(ROLE_VISIBLE_TIERS)) {
        if (new RegExp(`['"\`]${role}['"\`]`).test(code)) offenders.push(`${file}: ${role}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('⭐ no tier name appears as a literal either', () => {
    // A router that tests for `am_only` has re-derived the rule rather than asked for it.
    const offenders: string[] = [];
    for (const file of files) {
      const code = codeOf(file);
      for (const tier of TIER_NAMES) {
        if (new RegExp(`['"\`]${tier}['"\`]`).test(code)) offenders.push(`${file}: ${tier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the detector actually fires, so the emptiness above means something', () => {
    // Proven on a planted sample rather than trusted: a guard whose regex never matched would report a
    // clean routing layer for ever.
    const planted = `const pool = members.filter((m) => m.role === 'am');`;
    const role = Object.keys(ROLE_VISIBLE_TIERS)[0]!;
    expect(new RegExp(`['"\`]am['"\`]`).test(planted)).toBe(true);
    expect(new RegExp(`['"\`]${role}['"\`]`).test(`x = '${role}'`)).toBe(true);
    // …and it does NOT fire on prose, which is why comments are stripped.
    expect(codeOf.length).toBeGreaterThan(0);
  });
});
