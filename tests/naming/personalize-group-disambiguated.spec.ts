import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { stripComments } from '@crm/common';

/**
 * FR-028 (feature 024) — **the word "group" meant two unrelated things, and the two are kept apart.**
 *
 * `OverrideService.personalizeGroup` shipped in feature 011 and means *"apply one permission edit to a
 * hand-picked BATCH OF USERS at once"*. Feature 024 then introduced a real `Group` entity. Same word,
 * same service, same module — and this project has already paid for exactly this shape:
 * `Player.preferences_json` (a customer's VIP portfolio) collided with operator UI preferences in
 * feature 021, and the lesson recorded there is the reason this file exists —
 *
 *     "the name is taken" is precisely what makes the next person assume the thing is already built.
 *
 * What was renamed and what was not:
 *   • **TypeScript** — `personalizeSelection`, `PersonalizeSelectionRequest`,
 *     `override.selection.spec.ts`, `ResetTarget.scope = 'selection'`.
 *   • **The wire** — NOT renamed. `PersonalizeGroup`, `PersonalizeGroupRequest` and
 *     `RBAC_STATUS_CROSS_ROLE` keep their names because renaming an rpc trips `buf breaking`, the
 *     same wall `CheckBrandAccess` hit in feature 020. The collision is therefore DECLARED where it
 *     survives, and this spec is what makes the declaration mandatory rather than aspirational.
 */

/** Every file that is still allowed to say `personalizeGroup` must carry this marker. */
const MARKER = /NOT the `?Group`? (?:ENTITY|entity)|not the `?Group`? entity|feature 024/i;

const ROOTS = ['services', 'libs/common/src', 'web/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.next', 'gen']);

function sources(root: string): string[] {
  const abs = resolve(__dirname, '../..', root);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(p);
    }
  };
  walk(abs);
  return out;
}

const FILES = ROOTS.flatMap(sources);
const rel = (p: string) => p.replace(resolve(__dirname, '../..') + '\\', '').replace(/\\/g, '/');

describe('the batch-selection path and the Group entity are told apart (feature 024)', () => {
  it('scanned a plausible number of files', () => {
    // Anti-vacuous: a broken walk returns [] and everything below "passes".
    expect(FILES.length).toBeGreaterThan(200);
  });

  it('the detector fires on planted input', () => {
    expect(/\bpersonalizeGroup\b/.test('this.auth.personalizeGroup({})')).toBe(true);
    expect(/\bpersonalizeGroup\b/.test('this.overrides.personalizeSelection({})')).toBe(false);
    expect(MARKER.test('// NOT the Group ENTITY (feature 024)')).toBe(true);
    expect(MARKER.test('// just an ordinary comment')).toBe(false);
  });

  it('every surviving `personalizeGroup` is wire-bound AND carries the disambiguation marker', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const text = readFileSync(f, 'utf8');
      if (!/\bpersonalizeGroup\b/.test(stripComments(text))) continue;
      if (!MARKER.test(text)) offenders.push(rel(f));
    }
    expect(offenders).toEqual([]);
  });

  it('the survivors are exactly the two places bound to the unrenameable rpc', () => {
    // Pinned, not merely bounded: if a THIRD file starts saying it, that is a new use of the
    // ambiguous word and should have to justify itself here.
    const holders = FILES.filter((f) =>
      /\bpersonalizeGroup\b/.test(stripComments(readFileSync(f, 'utf8'))),
    ).map(rel);
    expect(holders.sort()).toEqual(
      [
        'services/gateway/src/rbac/access-management.controller.ts', // the gRPC client member = the wire name
        'services/gateway/src/rbac/access-management.write.spec.ts', // its fake, mirroring the wire name
      ].sort(),
    );
  });

  it('the auth service no longer names the batch path "group" at all', () => {
    const auth = sources('services/auth/src');
    for (const f of auth) {
      const src = stripComments(readFileSync(f, 'utf8'));
      expect(src).not.toMatch(/\bpersonalizeGroup\b/);
      expect(src).not.toMatch(/\bPersonalizeGroupRequest\b/);
    }
    // …and the replacement really is there, so this is not passing because the code vanished.
    const override = readFileSync(
      resolve(__dirname, '../../services/auth/src/rbac/override.service.ts'),
      'utf8',
    );
    expect(override).toContain('async personalizeSelection(');
  });

  it('the group ENTITY path never names the BATCH concept', () => {
    // The other direction of the same guard: the entity must not drift back towards the word that
    // caused the confusion.
    //
    // Narrower than "no `personalize` at all", deliberately. `group-grant-parity.spec.ts` calls
    // `personalizeUserRpc` on purpose — its whole subject is that granting through a group and
    // granting to a person give the same answer, and it cannot assert that without naming the direct
    // path. Banning the word outright would ban the proof, which is the same collision this guard
    // exists to prevent, one level up.
    const files = sources('services/auth/src/group');
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'));
      expect(src).not.toMatch(/personalizeGroup|personalizeSelection|PersonalizeGroupRequest/);
    }
    expect(files.length).toBeGreaterThanOrEqual(4);
  });

  it('the proto declares the collision at each surviving wire name', () => {
    const proto = readFileSync(
      resolve(__dirname, '../../libs/proto/crm/auth/v1/auth.proto'),
      'utf8',
    );
    // Comments are the artefact under test here, so the text is read unstripped on purpose.
    for (const anchor of [
      'rpc PersonalizeGroup(',
      'message PersonalizeGroupRequest',
      'RBAC_STATUS_CROSS_ROLE',
    ]) {
      const at = proto.indexOf(anchor);
      expect(at).toBeGreaterThan(-1);
      expect(proto.slice(Math.max(0, at - 700), at)).toMatch(
        /BATCH OF SELECTED USERS|SELECTION of users|batch of selected users/i,
      );
    }
  });

  it('the reset scope accepts the new spelling and keeps the legacy one working', () => {
    const src = readFileSync(
      resolve(__dirname, '../../services/auth/src/rbac/rbac.grpc.controller.ts'),
      'utf8',
    );
    expect(src).toContain('normaliseResetScope');
    // The behaviour itself is asserted in the auth workspace; here we only pin that the widening
    // exists at all, so removing it cannot pass unnoticed as a tidy-up.
    expect(stripComments(src)).toMatch(/'selection'/);
  });
});
