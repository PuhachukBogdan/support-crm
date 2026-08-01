import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from '@crm/common';
import { decideSubject, type SubjectBefore } from './subject.derive';

const ROOT = resolve(__dirname, '..', '..', '..', '..');
const CHATS_SRC = join(ROOT, 'services', 'chats', 'src');
const SKIP_DIRS = new Set(['generated', 'node_modules', 'dist']);

/**
 * T035 / T036 (feature 023, roadmap 4.18 — FR-022 / FR-024 / U9 / SC-011).
 *
 * ── The rule, in the operator's terms ───────────────────────────────────────────────────────────
 *   · an explicit HUMAN action wins and LOCKS the field;
 *   · an action a person invoked through a MACRO counts as human, and locks it too;
 *   · an automatic writer may touch only fields that are unset or were themselves set automatically,
 *     may keep updating topic and labels, and may never change a status.
 *
 * ── Why the guarantee is structural rather than a policy each writer consults ───────────────────
 * Every automated path refuses by a PREDICATE, not by remembering to check:
 *   · the write path — `decideSubject` returns null the moment `subject_source` is set (asserted here);
 *   · the sweep — its `where` carries `subject_source: null`, so a locked row matches zero rows;
 *   · a macro — has no subject action at all, and the guard below keeps it that way.
 *
 * That distinction matters because "every writer checks first" is a claim about code that does not
 * exist yet. A predicate is a claim about the query.
 */

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) yield full;
  }
}

const SOURCES = [...walk(CHATS_SRC)].map((f) => relative(ROOT, f).split(sep).join('/'));

/** Files allowed to WRITE the title, each with the reason it is allowed. */
const SANCTIONED_SUBJECT_WRITERS = [
  // The derivation, on the message path. Refuses a locked row via `decideSubject`.
  'services/chats/src/message/message.repository.ts',
  // The timeout sweep. Refuses a locked row via its `subject_source: null` predicate.
  'services/chats/src/subject/subject.sweep.ts',
  // The HUMAN path — the only one that may write `manual`.
  'services/chats/src/conversation/conversation.repository.ts',
];

/**
 * Does this source write the title?
 *
 * **Not** "a `subject:` key inside a `data:` literal" — the message path passes a computed
 * `data: change` object, so a literal-shaped matcher misses the most important writer of the three and
 * reports the exemption list as stale instead. The signal that actually holds across all three shapes
 * is: the file both **updates the conversation table** and **knows about `subject_source`**. Nothing
 * can lock or unlock a title without naming the column that carries the lock.
 */
function writesSubject(source: string): boolean {
  const code = stripComments(source).replace(/\s+/g, ' ');
  if (!/\.conversation\s*\.\s*(update|updateMany|upsert|create)\s*\(/.test(code)) return false;
  return /\bsubject_source\b/.test(code);
}

const MANUAL: SubjectBefore = {
  subject: 'выплата задерживается уже вторые сутки',
  subject_source: 'manual',
  category: 'payments',
};

const REAL_QUESTION = 'не пришёл депозит со вчера, что делать';

describe('T035 — a manual title is refused by every automated writer (FR-022 / SC-011)', () => {
  it('the derivation refuses it, whatever the message and whatever the count', () => {
    for (const authorType of ['player', 'operator', 'system'] as const) {
      for (const playerMessageCount of [1, 2, 3, 50]) {
        expect(
          decideSubject(MANUAL, {
            authorType,
            isPrivate: false,
            body: REAL_QUESTION,
            attachmentKind: 'image',
            playerMessageCount,
          }),
        ).toBeNull();
      }
    }
  });

  it('the sweep refuses it by PREDICATE — `subject_source: null` is in both its read and its write', () => {
    const code = stripComments(
      readFileSync(join(ROOT, 'services/chats/src/subject/subject.sweep.ts'), 'utf8'),
    ).replace(/\s+/g, ' ');
    // Twice: once selecting the row to close, once closing it. A locked row matches neither.
    const occurrences = [...code.matchAll(/subject_source\s*:\s*null/g)].length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('no macro or automation action can set a title — the vocabulary has no such action', () => {
    // U9's "an automatic classifier may never change a status" has a mirror here: the macro vocabulary
    // is a CLOSED catalogue (ADR 0014), and adding a subject action would be a deliberate act that
    // fails this test first.
    const vocabulary = readFileSync(
      join(ROOT, 'libs/proto/crm/chats/v1/chats.proto'),
      'utf8',
    );
    const actions = /enum MacroActionType \{([\s\S]*?)\n\}/.exec(vocabulary)?.[1] ?? '';
    expect(actions.length).toBeGreaterThan(40); // the scan found the enum
    expect(actions).not.toMatch(/SUBJECT/i);
  });

  it('only the sanctioned writers touch the column at all', () => {
    const offenders = SOURCES.filter(
      (p) =>
        !SANCTIONED_SUBJECT_WRITERS.includes(p) && writesSubject(readFileSync(join(ROOT, p), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the sanctioned list is not stale — each entry really does write it', () => {
    // An exemption that outlives its reason is the same disease as a permanently-false authz branch.
    for (const p of SANCTIONED_SUBJECT_WRITERS) {
      expect({ p, writes: writesSubject(readFileSync(join(ROOT, p), 'utf8')) }).toEqual({
        p,
        writes: true,
      });
    }
  });

  it('the scan reached the chats source, and the detector can fail', () => {
    expect(SOURCES.length).toBeGreaterThan(30);

    // A literal write…
    expect(
      writesSubject("await tx.conversation.updateMany({ data: { subject, subject_source: 'auto' } });"),
    ).toBe(true);
    // …and a COMPUTED one, which is the shape the message path uses and the shape a literal-matching
    // detector missed. This assertion is why the detector looks for the column, not for a key.
    expect(
      writesSubject(
        'const before = { subject_source: null }; await tx.conversation.updateMany({ data: change });',
      ),
    ).toBe(true);

    // A read is not a write, an update to another table is not a write, and neither is a comment.
    expect(writesSubject('await db.conversation.findMany({ select: { subject_source: true } });')).toBe(
      false,
    );
    expect(writesSubject("await db.message.updateMany({ data: { subject_source: 'x' } });")).toBe(false);
    expect(writesSubject("// await tx.conversation.updateMany({ data: { subject_source: 'auto' } });")).toBe(
      false,
    );
  });
});

describe('T036 — precedence among writers (U9 / FR-024)', () => {
  it('a human write LOCKS: `manual` is terminal for automation, `auto` only for automation', () => {
    // Both are terminal here because BOTH are checked by the same first branch — the difference is at
    // the human path, which has no `subject_source` predicate at all (a person may rename what another
    // person named). Stated as a test so the asymmetry is deliberate rather than incidental.
    const auto: SubjectBefore = { subject: 'derived', subject_source: 'auto', category: null };
    expect(decideSubject(auto, msg())).toBeNull();
    expect(decideSubject(MANUAL, msg())).toBeNull();

    const human = stripComments(
      readFileSync(join(ROOT, 'services/chats/src/conversation/conversation.repository.ts'), 'utf8'),
    );
    const setSubject = /async setSubject\([\s\S]*?\n {2}\}/.exec(human)?.[0] ?? '';
    expect(setSubject.length).toBeGreaterThan(200); // the scan found the method
    expect(setSubject).toMatch(/subject_source:\s*'manual'/);

    // The human path's `where` must NOT carry a `subject_source` predicate: a person may rename a
    // conversation another person named. Compared on the text BETWEEN `where:` and `data:` — the whole
    // method contains `subject_source` in its `data`, so a match over the method as a whole would be
    // testing nothing.
    const predicate = /where:\s*([\s\S]*?)\bdata:/.exec(setSubject)?.[1] ?? '';
    expect(predicate.length).toBeGreaterThan(3); // the split found both halves
    expect(predicate).not.toMatch(/subject_source/);
  });

  it('an automatic writer may write an UNSET field', () => {
    const open: SubjectBefore = { subject: null, subject_source: null, category: null };
    expect(decideSubject(open, msg())).toEqual({ subject: REAL_QUESTION });
  });

  it('an automatic writer may keep updating the TOPIC — only the title freezes (FR-023)', () => {
    // Nothing in the derivation writes `category`, and nothing in it reads a frozen title to decide
    // whether classification may continue. Asserted as an absence, because that is the guarantee.
    const derive = stripComments(
      readFileSync(join(ROOT, 'services/chats/src/subject/subject.derive.ts'), 'utf8'),
    );
    expect(derive).not.toMatch(/category\s*:\s*[^)]*\breturn\b/);
    expect(derive).toMatch(/category/); // it READS the topic for the fallback…
    const change = decideSubject(
      { subject: null, subject_source: null, category: 'payments' },
      msg({ body: 'привет', playerMessageCount: 3 }),
    );
    expect(Object.keys(change!)).toEqual(['subject', 'subject_source']); // …and never writes it
  });

  it('an automatic writer may NEVER change a status — the derivation cannot express one', () => {
    // U9's sharpest clause. `SubjectChange` has exactly two optional keys, so a classifier riding this
    // path has no field in which to put a status even if it wanted one.
    for (const before of [MANUAL, { subject: null, subject_source: null, category: null }]) {
      const change = decideSubject(before, msg({ playerMessageCount: 3 }));
      for (const key of Object.keys(change ?? {})) {
        expect(['subject', 'subject_source']).toContain(key);
      }
    }
  });
});

function msg(over: Partial<Parameters<typeof decideSubject>[1]> = {}) {
  return {
    authorType: 'player' as const,
    isPrivate: false,
    body: REAL_QUESTION,
    attachmentKind: null,
    playerMessageCount: 1,
    ...over,
  };
}
