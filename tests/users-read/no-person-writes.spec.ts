import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from '@crm/common';

const ROOT = resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'generated', '.git']);

/**
 * Feature 022 (roadmap 4.13), T051 — **this feature READS links and never makes one.**
 *
 * ── Why that boundary is worth a test ───────────────────────────────────────────────────────────
 * Two records becoming one person is a statement about a HUMAN, made AUTOMATICALLY on a matching email or
 * phone (feature 020). It is audited (`player.link` / `player.unlink`) precisely because an automatic
 * decision needs a record of itself: a wrong link is otherwise visible only as a customer card that
 * quietly contains someone else.
 *
 * Feature 022 consumes that decision from two new places — `chats` (to answer a person's feed and summary)
 * and the `users` player read (to say which person a record belongs to). Each of those is a plausible spot
 * for someone to later "helpfully" create a missing link, and such a write would bypass 020's contact-hash
 * matching AND its audit entry. So the absence of a write path is asserted rather than assumed, which is
 * the same discipline `tests/audit/append-only.spec.ts` applies to audit entries.
 */

/** Prisma write verbs on the person models. */
const WRITE_VERBS = [
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
];

const MODELS = ['person', 'personMember'];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) yield full;
  }
}

/** Comments stripped first: the notes explaining WHERE linking lives legitimately name these calls. */
export function writesPersonRows(source: string): string[] {
  const code = stripComments(source);
  const hits: string[] = [];
  for (const model of MODELS) {
    for (const verb of WRITE_VERBS) {
      if (new RegExp(String.raw`\.${model}\s*\.\s*${verb}\s*\(`).test(code)) {
        hits.push(`${model}.${verb}`);
      }
    }
  }
  return hits;
}

const SOURCES = [
  ...walk(join(ROOT, 'services')),
  ...walk(join(ROOT, 'libs')),
].map((f) => relative(ROOT, f).split(sep).join('/'));

/**
 * The ONE place allowed to create or remove a link, and it predates this feature.
 *
 * ⚠️ Verified below to still contain writes: a stale exemption is the same disease as a permanently-false
 * authorization branch — it reads as a live decision while deciding nothing.
 */
const ALLOWED = [
  {
    path: 'services/users/src/player/person.service.ts',
    why: 'feature 020 — `linkByContact` / `unlink`, on a matching contact hash, each writing its audit entry',
  },
  {
    /**
     * FIXTURES, and this guard caught it the moment it was added — which is the guard working, not a
     * nuisance. The seed asserts the link DIRECTLY rather than seeding two matching contact hashes and
     * letting feature 020's matcher run: a fixture that depends on another feature's inference fails for
     * reasons that are not this feature's, and feature 018's live run already taught that lesson once.
     *
     * The trade is explicit: the seed does not exercise the linking rule, and it is not supposed to —
     * `person.spec.ts` covers that. It exercises the READS that consume a link, which is feature 022.
     */
    path: 'services/users/prisma/seed.ts',
    why: 'the Track-B fixture: one person linking two brand records, asserted directly rather than inferred',
  },
];

describe('T051 — only feature 020’s person service writes person rows', () => {
  it('the scan reached the source tree (a guard that scans nothing must fail)', () => {
    expect(SOURCES.length).toBeGreaterThan(200);
    expect(SOURCES).toContain('services/users/src/player/person.service.ts');
    // The three files this feature added that READ links — they must be scanned, not merely absent.
    expect(SOURCES).toContain('services/users/src/player/player.repository.ts');
    expect(SOURCES).toContain('services/chats/src/person/person-members.client.ts');
    expect(SOURCES).toContain('services/chats/src/contact/contact.grpc.controller.ts');
  });

  it('no file outside the person service writes a Person or PersonMember row', () => {
    const allowed = new Set(ALLOWED.map((a) => a.path));
    const offenders = SOURCES.filter((p) => !allowed.has(p))
      .map((p) => ({ p, hits: writesPersonRows(readFileSync(join(ROOT, p), 'utf8')) }))
      .filter(({ hits }) => hits.length > 0)
      .map(({ p, hits }) => `${p}: ${hits.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('the exemption is still needed (the person service does write)', () => {
    const hits = writesPersonRows(
      readFileSync(join(ROOT, 'services/users/src/player/person.service.ts'), 'utf8'),
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  it('the files feature 022 added read links and write none', () => {
    for (const path of [
      'services/users/src/player/player.repository.ts',
      'services/chats/src/person/person-members.client.ts',
      'services/chats/src/contact/contact.grpc.controller.ts',
      'services/chats/src/feed/feed.grpc.controller.ts',
    ]) {
      const src = readFileSync(join(ROOT, path), 'utf8');
      expect({ path, writes: writesPersonRows(src) }).toEqual({ path, writes: [] });
    }
  });
});

describe('T051 — the detector can fail (proved on planted input)', () => {
  it('flags each write verb on each model', () => {
    for (const model of MODELS) {
      for (const verb of WRITE_VERBS) {
        expect(writesPersonRows(`await db.${model}.${verb}({ data });`)).toEqual([
          `${model}.${verb}`,
        ]);
      }
    }
  });

  it('does not flag a READ', () => {
    expect(writesPersonRows('await db.personMember.findMany({ where });')).toEqual([]);
    expect(writesPersonRows('await db.person.findFirst({ where });')).toEqual([]);
  });

  it('does not flag a write to a different model with a similar name', () => {
    expect(writesPersonRows('await db.personalNote.create({ data });')).toEqual([]);
  });

  it('ignores a COMMENTED call — the note explaining where linking lives must survive', () => {
    // `person-members.client.ts` and `player.repository.ts` both explain that linking stays feature 020's.
    // A token ban would delete exactly those sentences.
    expect(writesPersonRows('// linking stays 020: db.personMember.create({ data })')).toEqual([]);
    expect(writesPersonRows('/* never: db.person.delete({ where }) */')).toEqual([]);
  });

  it('is not fooled by a `//` inside a string literal', () => {
    expect(
      writesPersonRows('const u = "a//b"; await db.personMember.create({ data });'),
    ).toEqual(['personMember.create']);
  });
});
