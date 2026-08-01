import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from '@crm/common';

/**
 * Feature 022 (roadmap 4.13), T015 — **a message row may be created in exactly two places.**
 *
 * ── Why this guard exists ────────────────────────────────────────────────────────────────────────
 * The player card's "when did we last talk to this customer" is now two maintained columns on
 * `Conversation`, written inside `MessageRepository.post`'s transaction. That guarantee is worth
 * exactly as much as the claim "nothing else creates a message" — and that claim was **already false
 * when this feature started**, in a way a grep for `message.create` did not show:
 *
 *   `services/chats/prisma/seed.ts` writes messages with `message.upsert`.
 *
 * Seeded conversations therefore carry no stamps unless the fixtures supply them, and **Track B runs on
 * the seed** — so the live run would have reported a product defect that was really a fixture defect
 * (feature 018's lesson, one field over). Found by looking for a second writer rather than assuming
 * there was none, which is why this guard bans `upsert` and `createMany` too, not just `create`.
 *
 * ── What it does NOT claim ───────────────────────────────────────────────────────────────────────
 * It does not prove the stamp is correct — `contact-stamp.spec.ts` proves the rule,
 * `message.post.spec.ts` proves the call site, Track B proves the stored values. This guard proves
 * there is no THIRD place where a message could be born without one.
 *
 * ── ⚠️ Comments are stripped first ──────────────────────────────────────────────────────────────
 * A guard that bans a token from the source also bans it from the note explaining the ban — and that
 * note is the most valuable line in the file. Three guards written on 2026-07-29 each failed on their
 * own retraction comments, which is why `stripComments` is shared rather than re-derived here.
 */

const ROOT = resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git', 'gen', 'generated']);

/** Prisma write verbs that can bring a `Message` row into existence. */
const CREATING_VERBS = ['create', 'createMany', 'createManyAndReturn', 'upsert'] as const;

/**
 * The two files allowed to create a message, each for a stated reason.
 *
 * ⚠️ Both exemptions are verified below: if an allowed file stops creating messages, the exemption is
 * stale and this suite fails. A permanently-true exemption is the same disease as a permanently-false
 * authorization branch — it reads as a live decision while deciding nothing.
 */
const ALLOWED: ReadonlyArray<{ path: string; why: string }> = [
  {
    path: 'services/chats/src/message/message.repository.ts',
    why: 'the production write — the ONE place that also stamps the conversation, in the same transaction',
  },
  {
    path: 'services/chats/prisma/seed.ts',
    why: 'fixtures. It bypasses the repository, so `seed.build.ts` must derive the stamps itself (research R3)',
  },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts')) yield full;
  }
}

/**
 * The detector, extracted so the self-check exercises the pipeline it actually is (strip, then match)
 * rather than the regex alone — the `no-direct-network` guard's first self-check tested its matcher
 * while its detector was the pipeline, so it proved the wrong thing and passed.
 *
 * Matches `<anything>.message.<verb>(` — which covers `prisma.message.create`,
 * `db.message.upsert`, `tx.message.create` and the scoped-client forms, without matching a delegate
 * called `message` on something that is not Prisma closely enough to matter: a false positive here is a
 * file to look at, which is the safe way to be wrong.
 */
export function createsMessages(source: string): boolean {
  const code = stripComments(source);
  return CREATING_VERBS.some((verb) =>
    new RegExp(String.raw`\.message\s*\.\s*${verb}\s*\(`).test(code),
  );
}

const SOURCES = [...walk(join(ROOT, 'services')), ...walk(join(ROOT, 'libs'))].map((f) =>
  relative(ROOT, f).split(sep).join('/'),
);

describe('T015 — a Message row is created in exactly two places', () => {
  it('the scan reached a meaningful number of files (a guard that scans nothing must fail)', () => {
    // The 2026-07-29 lesson: a `git grep` that could not run was being read as "no matches", so a guard
    // went permanently green wherever git was unavailable. Assert the scan happened.
    expect(SOURCES.length).toBeGreaterThan(200);
    expect(SOURCES).toContain('services/chats/src/message/message.repository.ts');
    expect(SOURCES).toContain('services/chats/prisma/seed.ts');
  });

  it('no file outside the two allowed ones creates a message', () => {
    const allowed = new Set(ALLOWED.map((a) => a.path));
    const offenders = SOURCES.filter(
      (path) => !allowed.has(path) && createsMessages(readFileSync(join(ROOT, path), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('every exemption is still needed (a stale allowance fails here)', () => {
    for (const { path } of ALLOWED) {
      const stillWrites = createsMessages(readFileSync(join(ROOT, path), 'utf8'));
      expect({ path, stillWrites }).toEqual({ path, stillWrites: true });
    }
  });

  it('the production writer stamps the conversation in the same call', () => {
    // The reason the ban is worth having: the allowed file must be the one that maintains the columns.
    // If the stamp ever moves out of `post`, the exemption above would still hold while the guarantee
    // it protects would be gone.
    const src = readFileSync(
      join(ROOT, 'services/chats/src/message/message.repository.ts'),
      'utf8',
    ).replace(/\s+/g, ' ');
    expect(src).toMatch(/decideContactStamp\(/);
    expect(src).toMatch(/\$transaction\(async \(tx\) =>/);
    expect(src).toMatch(/tx\.conversation\.updateMany\(/);
  });

  it('`$transaction` is called on the client and never destructured (feature 013’s live-only defect)', () => {
    const code = stripComments(
      readFileSync(join(ROOT, 'services/chats/src/message/message.repository.ts'), 'utf8'),
    );
    // Pulling it into a variable loses its `this` and Prisma dies on `this._engineConfig` — invisible
    // to a unit-test fake, which is a standalone function that never needed `this`.
    expect(code).not.toMatch(/(const|let|var)\s+\w+\s*=\s*\w+\.\$transaction/);
    expect(code).not.toMatch(/\{\s*\$transaction\s*(:|,|\})/);
  });
});

describe('T015 — the detector can fail (proved on planted input)', () => {
  it('flags each creating verb', () => {
    for (const verb of CREATING_VERBS) {
      expect(createsMessages(`await db.message.${verb}({ data });`)).toBe(true);
    }
  });

  it('flags the transaction-client form', () => {
    expect(createsMessages('await tx.message.create({ data, select: S });')).toBe(true);
  });

  it('does not flag a read', () => {
    expect(createsMessages('await db.message.findMany({ where });')).toBe(false);
  });

  it('does not flag a write to another model', () => {
    expect(createsMessages('await db.messageAttachment.createMany({ data });')).toBe(false);
    expect(createsMessages('await db.conversation.create({ data });')).toBe(false);
  });

  it('ignores a COMMENTED example — the case that breaks a naive token ban', () => {
    // This is not hypothetical: Prisma's own generated docs contain `prisma.message.create` in comments,
    // and every one of this feature's sibling guards tripped on its own explanatory note first.
    expect(createsMessages('// await db.message.create({ data });')).toBe(false);
    expect(createsMessages('/* db.message.upsert({ where, create, update }) */')).toBe(false);
  });

  it('is not fooled by a `//` inside a string literal', () => {
    // A regex-only comment stripper truncates this line and stops seeing the call after it — a false
    // pass, which is worse than no guard.
    expect(createsMessages('const u = "https://x/y"; await db.message.create({ data });')).toBe(
      true,
    );
  });
});
