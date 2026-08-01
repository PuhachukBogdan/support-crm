import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { stripComments } from '@crm/common';

const ROOT = resolve(__dirname, '..', '..');
const CHATS_SRC = join(ROOT, 'services', 'chats', 'src');
const SKIP_DIRS = new Set(['generated', 'node_modules', 'dist']);

/**
 * Feature 022 (roadmap 4.13), T063 — **one paged list over `Conversation`, not two.**
 *
 * ── The requirement, and the version of it that could not be tested ─────────────────────────────
 * FR-012 originally read "a structural test MUST assert exactly one player-conversation list query path".
 * As written it was unusable: this feature ADDS a read over the same rows, so the guard would either
 * forbid the feature's own aggregate or forbid nothing at all. `/speckit-analyze` flagged it, and the
 * predicate was sharpened before any code was written:
 *
 *   **An aggregate is not a list.** What is forbidden is a SECOND paged `findMany` over `Conversation` —
 *   a call that returns summaries with a page token. A `groupBy` returns no rows to page through and is
 *   explicitly permitted.
 *
 * ── Why the rule is worth a guard at all ────────────────────────────────────────────────────────
 * Feature 017 shipped a second read over these rows and Track B found that the two "identical" filter
 * vocabularies had ALREADY drifted — `pending` on one side, `running` on the other — inside the file whose
 * header promised they were the same. The player feed and the person feed are therefore deliberately the
 * same path one identity wider, and they live in the same controller for that reason.
 *
 * The case this file pins hardest is the PERMITTED one: the guard must stay green with the aggregate
 * present. A guard that forbids the thing it was written alongside is a guard someone will delete.
 */

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) yield full;
  }
}

/** A paged list over `Conversation`: `conversation.findMany` with a `take`. */
export function pagesConversations(source: string): boolean {
  const code = stripComments(source).replace(/\s+/g, ' ');
  for (const m of code.matchAll(/\.conversation\s*\.\s*findMany\s*\(/g)) {
    // The `take: limit + 1` idiom is what makes a read a PAGE (keyset paging computes the next cursor
    // from the extra row). A `findMany` without it is a bounded internal lookup, not a list endpoint.
    const tail = code.slice(m.index!, m.index! + 400);
    if (/take\s*:/.test(tail)) return true;
  }
  return false;
}

/** An aggregate over `Conversation` — permitted, and asserted to be permitted. */
export function aggregatesConversations(source: string): boolean {
  return /\.conversation\s*\.\s*(groupBy|aggregate|count)\s*\(/.test(stripComments(source));
}

const SOURCES = [...walk(CHATS_SRC)].map((f) => relative(ROOT, f).split(sep).join('/'));

/**
 * The single paged-list owner. Both feeds (`GetPlayerFeed`, `GetPersonFeed`) and the inbox call into it —
 * one query builder, one filter vocabulary, one page cap.
 */
const LIST_OWNER = 'services/chats/src/conversation/conversation.repository.ts';

describe('T063 — exactly one paged list over Conversation exists in chats', () => {
  it('the scan reached the chats source (a guard that scans nothing must fail)', () => {
    expect(SOURCES.length).toBeGreaterThan(30);
    expect(SOURCES).toContain(LIST_OWNER);
    expect(SOURCES).toContain('services/chats/src/contact/contact-summary.repository.ts');
  });

  it('only the conversation repository pages conversations', () => {
    const offenders = SOURCES.filter(
      (p) => p !== LIST_OWNER && pagesConversations(readFileSync(join(ROOT, p), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the owner really does page (so the exemption is not stale)', () => {
    expect(pagesConversations(readFileSync(join(ROOT, LIST_OWNER), 'utf8'))).toBe(true);
  });

  it('the AGGREGATE is permitted, and it is present — the case that keeps this guard honest', () => {
    // If this ever fails, the guard has started forbidding the read it was written beside, and the right
    // repair is the predicate — not deleting the feature's own query.
    const summary = readFileSync(
      join(ROOT, 'services/chats/src/contact/contact-summary.repository.ts'),
      'utf8',
    );
    expect(aggregatesConversations(summary)).toBe(true);
    expect(pagesConversations(summary)).toBe(false);
  });

  it('both feeds go through the one owner rather than building their own query', () => {
    // The player feed and the person feed are the same question one identity wider. Two builders would
    // drift, exactly as feature 017's two filter vocabularies already had.
    const feed = stripComments(
      readFileSync(join(ROOT, 'services/chats/src/feed/feed.grpc.controller.ts'), 'utf8'),
    );
    expect(feed).not.toMatch(/\.conversation\s*\.\s*findMany/);
    expect(feed).toMatch(/repo\.list\(|this\.repo\./);
  });
});

describe('T063 — the detector can fail (proved on planted input)', () => {
  it('flags a paged findMany', () => {
    expect(
      pagesConversations(
        'const rows = await db.conversation.findMany({ where, orderBy, take: limit + 1 });',
      ),
    ).toBe(true);
  });

  it('does NOT flag an aggregate', () => {
    expect(
      pagesConversations('await db.conversation.groupBy({ by: ["channel"], _count: true });'),
    ).toBe(false);
  });

  it('does NOT flag a bounded single-row lookup', () => {
    // `findFirst` for a brand check, or a `findMany` with no `take`, is not a list endpoint — flagging it
    // would make the guard ban ordinary internal reads and guarantee its own deletion.
    expect(pagesConversations('await db.conversation.findFirst({ where: { id } });')).toBe(false);
    expect(pagesConversations('await db.conversation.findMany({ where: { id: { in: ids } } });')).toBe(
      false,
    );
  });

  it('ignores a COMMENTED example', () => {
    expect(
      pagesConversations('// await db.conversation.findMany({ where, take: limit + 1 });'),
    ).toBe(false);
  });

  it('is not fooled by a `//` inside a string literal', () => {
    expect(
      pagesConversations(
        'const u = "https://x//y"; await db.conversation.findMany({ where, take: 10 });',
      ),
    ).toBe(true);
  });
});
