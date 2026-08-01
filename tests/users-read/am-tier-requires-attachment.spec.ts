import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from '@crm/common';

/**
 * T027 (feature 026, roadmap 5.7 — FR-014): **the attachment is an EXPLICIT input, everywhere.**
 *
 * ── Why a structural guard on top of the behavioural ones ───────────────────────────────────────
 * The behavioural tests prove the rule is right. They cannot prove that **every caller asks it**, and
 * that is the half that decays: a new read surface added next year will compile the moment it passes
 * *something*, and `true` is the something that compiles fastest.
 *
 * Making the parameter required already forces every call site to pass a value. This guard is about
 * WHICH value: a literal `true` at a call site is a narrowing that has been switched off, and it
 * looks exactly like a narrowing that is working.
 *
 * ── ⚠️ The enumeration is the real deliverable (SC-009) ─────────────────────────────────────────
 * *"We changed the masking function"* and *"we know who was affected"* are different statements.
 * The pinned list below is the second one, and it fires when a sixth reader appears — which is
 * exactly the moment somebody should be asked whether it narrows.
 */

const REPO_ROOT = resolve(__dirname, '../..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.next', 'gen', 'migrations']);

function sources(root: string): string[] {
  const abs = resolve(REPO_ROOT, root);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
    }
  };
  walk(abs);
  return out;
}

const FILES = sources('services').concat(sources('libs'));
const rel = (p: string) => relative(REPO_ROOT, p).split(sep).join('/');
const read = (f: string) => stripComments(readFileSync(f, 'utf8'));

/** Anything that decides what fields a caller may see about a player. */
const TIER_READER = /\b(maskPlayer|allowedFields|surfacedMaskableTiers|visibleTiersForSubject)\s*\(/;

/** The switched-off narrowing: a literal `true` handed to the attachment argument. */
const HARDCODED_TRUE = /attachedToSubject:\s*true/;

describe('the AM tier is decided per RECORD, everywhere it is decided (feature 026)', () => {
  it('scanned a plausible number of files', () => {
    expect(FILES.length).toBeGreaterThan(200);
  });

  it('the detectors fire on planted input', () => {
    expect(TIER_READER.test('const f = allowedFields(role, opts);')).toBe(true);
    expect(HARDCODED_TRUE.test('maskPlayer(p, role, { attachedToSubject: true })')).toBe(true);
    expect(HARDCODED_TRUE.test('maskPlayer(p, role, { attachedToSubject })')).toBe(false);
    expect(TIER_READER.test('const x = surfacedMaskableTiersForRole(role);')).toBe(false);
  });

  it('⭐ no PRODUCTION call hardcodes the attachment to `true`', () => {
    // A literal `true` is a narrowing that has been switched off — and from a diff it is
    // indistinguishable from one that is working.
    const offenders = FILES.filter((f) => HARDCODED_TRUE.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('⭐ the readers of the tier are EXACTLY these, and each was decided on (SC-009)', () => {
    // Pinned, not bounded. A sixth reader is a new claim about who may see a customer's private data,
    // and it should have to argue for itself here.
    //
    //   • player.grpc.controller.ts — GetPlayer and ListPlayersByBrand.        NARROW.
    //   • player.masking.ts         — the allow-list builder they both use.    NARROW.
    //   • contact-view-audit.service.ts — recordView NARROWS (it names one record);
    //     recordBulkRead does NOT (it names a brand, so there is no single attachment to ask about,
    //     and narrowing there would UNDERSTATE the trail — the mirror mistake).
    const holders = FILES.filter((f) => TIER_READER.test(read(f))).map(rel).sort();
    expect(holders).toEqual(
      [
        'libs/common/src/policy/field-tiers.ts', // the rule itself
        'services/users/src/player/contact-view-audit.service.ts',
        'services/users/src/player/player.grpc.controller.ts',
        'services/users/src/player/player.masking.ts',
      ].sort(),
    );
  });

  it('the rule is DERIVED from the tier map, not from a list of role names', () => {
    // A hardcoded ['am','shift_am'] drifts the first time a role is added, and drifts silently.
    const src = read(resolve(REPO_ROOT, 'libs/common/src/policy/field-tiers.ts'));
    const rule = /export function visibleTiersForSubject[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(rule).toContain('masked_pii');
    expect(rule).not.toMatch(/'am'|'shift_am'/);
  });

  it('the bulk-read audit uses the ROLE-level helper, deliberately', () => {
    const src = read(resolve(REPO_ROOT, 'services/users/src/player/contact-view-audit.service.ts'));
    expect(src).toContain('surfacedMaskableTiersForRole');
    // …and the per-record path does not.
    expect(src).toMatch(/surfacedMaskableTiers\(roleKey,\s*\{\s*attachedToSubject\s*\}\)/);
  });

  it('the list path resolves attachments ONCE per page, never per row', () => {
    // An N+1 here would sit on a screen that grows with the customer base (Principle VII).
    const src = read(resolve(REPO_ROOT, 'services/users/src/player/player.grpc.controller.ts'));
    expect(src).toContain('attachedAmong');
    // The per-row helper must not appear inside the list handler's row mapping.
    const listBlock = /listPlayersByBrand[\s\S]*?nextPageToken/.exec(src)?.[0] ?? '';
    expect(listBlock).not.toContain('isAttached(');
  });
});
