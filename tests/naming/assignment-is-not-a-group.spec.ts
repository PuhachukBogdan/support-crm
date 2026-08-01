import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from '@crm/common';

/**
 * T037 (feature 026, roadmap 5.7 — FR-026 / ADR 0039 §10): **an attachment is not a group.**
 *
 * ── Why this needs a guard rather than a sentence ───────────────────────────────────────────────
 * The two look alike from a distance — both connect staff to work — and one is already built, which
 * makes it the tempting implementation. ADR 0039 §10 says no in as many words, and the reason is
 * about REACH:
 *
 *   • a **group** is a unit of staff; membership widens what its members can do collectively;
 *   • an **attachment** is per-player, and it is narrower on purpose.
 *
 * Expressing a portfolio as a group would widen a manager's reach from *"my players"* to *"every
 * VIP"* — the exact opposite of feature 026's point, which is that an AM should see **less** than
 * they do today. The failure would not look like a bug: portfolios would work, and the narrowing
 * would quietly be undone.
 *
 * ── And the reverse direction, which is the one nobody watches ──────────────────────────────────
 * A group that started reading attachments would make desk membership imply portfolio access. Both
 * directions are asserted; only one of them is the obvious mistake.
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
      else if (p.endsWith('.ts')) out.push(p);
    }
  };
  walk(abs);
  return out;
}

const rel = (p: string) => relative(REPO_ROOT, p).split(sep).join('/');
const read = (f: string) => stripComments(readFileSync(f, 'utf8'));

const ASSIGNMENT_FILES = sources('services/users/src/assignment');
const GROUP_FILES = sources('services/auth/src/group');

/** The group vocabulary: the entity, its membership, its grants. */
const GROUP_TERMS = /\b(GroupMember|GroupPermission|groupMember|groupPermission|listGroupMembers)\b/;
/** The attachment vocabulary. */
const ASSIGNMENT_TERMS = /\b(PlayerAssignment|playerAssignment|attachedAmong|isAttached)\b/;

describe('an attachment is not a group, and neither reads the other (feature 026)', () => {
  it('both sides were actually found (anti-vacuous)', () => {
    // Without this, two empty walks would make every assertion below pass.
    expect(ASSIGNMENT_FILES.length).toBeGreaterThanOrEqual(4);
    expect(GROUP_FILES.length).toBeGreaterThanOrEqual(3);
  });

  it('the detectors fire on planted input', () => {
    expect(GROUP_TERMS.test('await db.groupMember.findMany({})')).toBe(true);
    expect(ASSIGNMENT_TERMS.test('await repo.isAttached(a, p, u)')).toBe(true);
    expect(GROUP_TERMS.test('const group = "Support";')).toBe(false);
  });

  it('⭐ no assignment file reaches for the GROUP vocabulary', () => {
    const offenders = ASSIGNMENT_FILES.filter((f) => GROUP_TERMS.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('⭐ and no group file reaches for the ATTACHMENT vocabulary', () => {
    // The direction nobody watches: a group that read attachments would make desk membership imply
    // portfolio access, which is the same widening arriving from the other end.
    const offenders = GROUP_FILES.filter((f) => ASSIGNMENT_TERMS.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('the attachment lives in a different SERVICE from the group, and that is structural', () => {
    // Groups are an authorization input resolved in `auth`; an attachment is a fact about a customer
    // and lives with the customer in `users`. Databases per service (Principle VIII) make merging
    // them impossible without somebody noticing.
    expect(ASSIGNMENT_FILES.every((f) => rel(f).startsWith('services/users/'))).toBe(true);
    expect(GROUP_FILES.every((f) => rel(f).startsWith('services/auth/'))).toBe(true);
  });

  it('the attachment is keyed on ONE PLAYER, never on a set', () => {
    // The narrowness IS the feature. A method taking a list of players to attach at once would be a
    // group by another name — and would also be the bulk-assign verb the contract deliberately omits,
    // since attaching many players quickly is the harvesting pattern the audit exists to detect.
    const repo = read(resolve(REPO_ROOT, 'services/users/src/assignment/assignment.repository.ts'));
    expect(repo).not.toMatch(/attachMany|assignMany|bulkAssign/);
  });

  it('ADR 0039 §10 is cited where somebody would be tempted', () => {
    // A rule whose reason lives only in an ADR is a rule the next reader has to go and find.
    const raw = readFileSync(
      resolve(REPO_ROOT, 'services/users/prisma/schema.prisma'),
      'utf8',
    );
    expect(raw).toMatch(/NOT A GROUP \(ADR 0039 §10\)/);
  });
});
