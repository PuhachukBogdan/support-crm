import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * T016 (feature 031, FR-023) — **who writes `assignee_operator_id`, counted.**
 *
 * ── Why a scan for writes to the COLUMN, and not for calls to a method ──────────────────────────
 * Feature 023 attached the transition stream to "the assignment path" and found the truth by scanning:
 * the task list named **2** writers, reading the code by hand found **4**, and a structural guard found
 * **5**. The fifth was auto-assignment, which writes the column directly and is therefore invisible to any
 * search by method name. That missing 20 % is exactly the question analytics asks — *how much work does
 * routing move?* — and a partial stream **looks complete and answers wrongly**, which is worse than
 * refusing to answer.
 *
 * ⚠️ Feature 031 adds another writer (the backlog drain), so the count is pinned here rather than
 * remembered. If this fails, a path started assigning work and nothing else noticed.
 *
 * ── Dear implementer who just went red ─────────────────────────────────────────────────────────
 * A new writer of this column must ALSO record a transition and respect capacity. Update the number below
 * only once you have checked both — the number is a prompt, not a formality.
 */

const SRC = join(__dirname, '..', '..', 'src');

/** Every non-spec `.ts` under `dir`, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    // ⛔ `generated/` is Prisma's own client: it names every column of every table by construction, so
    // including it would make this guard a test of the ORM rather than of our code.
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts') && !p.includes('generated'))
      out.push(p);
  }
  return out;
}

/**
 * Comments are stripped BEFORE the search. The column is discussed in prose all over this service —
 * including in this file's own header — and a guard that counted comments would report writers that do
 * not exist and could only be silenced by deleting the explanations.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function codeOf(file: string): string {
  return stripComments(readFileSync(file, 'utf8'));
}

/**
 * A WRITE, not a mention. `assignee_operator_id:` as an object key is how Prisma expresses both a
 * predicate and an assignment, so a `where` clause reads the same as a `data` clause at this resolution —
 * which is why the count is per FILE rather than per occurrence: a file that merely filters on the column
 * still has to be looked at once, and once is the point.
 */
const MENTIONS = /assignee_operator_id\s*:/;

describe('writers of assignee_operator_id (T016)', () => {
  const files = walk(SRC).filter((f) => MENTIONS.test(codeOf(f)));

  it('the scan finds files at all — it is not vacuous', () => {
    // Feature 030's first version of a guard like this matched zero files and would have passed for ever.
    expect(files.length).toBeGreaterThan(0);
  });

  it('⭐ the set of files touching the column is EXACTLY what we expect', () => {
    const names = files.map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/')).sort();
    expect(names).toEqual([
      // The router: selects a candidate and claims the conversation (013/024, extended by 031).
      'assignment/assignment.repository.ts',
      // Feature 031: the backlog FILTERS on the assignee (queued work must still be unowned) while
      // writing `backlog_at`. It is on this list because the list is per FILE — a file that touches the
      // column has to be looked at once, and once is the point.
      'assignment/backlog.ts',
      // Feature 031, second half: the drain's UNSCOPED read filters on the assignee too — queued work
      // must still be unowned. On the list for the same per-FILE reason as `backlog.ts`.
      'assignment/backlog-sweep.repository.ts',
      'assignment/group-pool.ts',
      // ⭐ W31 / feature 038 (ADR 0043 §4, SEC-PV2): the offboarding handover — the newest writer, and
      // the only one that CLEARS the column deliberately. It obeys both terms of this guard's own
      // instruction: it records a `conversation.assigned` transition inside the same transaction, and
      // it respects capacity by not assigning at all — the work goes back to the queue, which is where
      // capacity is decided (the drain re-reads it per item).
      'assignment/handover.repository.ts',
      'assignment/round-robin-state.repository.ts',
      // ⭐ Automations and macros ASSIGN too — the two writers a search for "the routing path" misses,
      // and precisely the shape feature 023's guard was built to surface.
      'automation/automations.repository.ts',
      'macros/macros.repository.ts',
      // The list/read layer filters on it.
      'conversation/conversation.repository.ts',
      // ⭐ W25: the unread badge COUNTS the caller's own slice — a scoped READ (assignee = me),
      // never a write; enrolled so the exact-set guard stays exact.
      'conversation/inbox-unseen.repository.ts',
      // The subject sweep reads it; the wire maps it; the transition stream records what changed.
      'shared/wire.ts',
      'subject/subject.sweep.ts',
      'transition/conversation-transitions.ts',
    ].sort());
  });

  it('⚠️ the detector fires on a planted write, so the list above means something', () => {
    // Proven rather than trusted: a regex that never matched would certify any codebase.
    expect(MENTIONS.test('data: { assignee_operator_id: operatorId }')).toBe(true);
    expect(MENTIONS.test('where: { assignee_operator_id: { in: ids } }')).toBe(true);
    // …and it does not fire on prose, which is why comments are stripped first.
    expect(stripComments('// assignee_operator_id: discussed here\nconst x = 1;')).not.toMatch(
      MENTIONS,
    );
  });
});
