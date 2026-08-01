import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from '@crm/common';

/**
 * Feature 023 (roadmap 4.8a) — **every writer of `status` or `assignee_operator_id` records a
 * transition.** The guard that makes the stream complete rather than merely present.
 *
 * ── Why this exists, and it is the whole reason T017/T018 were blocked ───────────────────────────
 * The task said "record from the conversation write path" and "record from the assignment
 * repository". There are FOUR writers of those two columns, not two: the two named ones plus the
 * macro applier (013) and the automation applier (014). Wiring only the named pair would produce a
 * stream that silently misses every status and assignment change caused by a macro or a rule — and
 * those are exactly the changes the analytics question is about ("how much does automation move?").
 *
 * A partial stream is worse than none: it looks complete and answers wrongly. That is the failure
 * mode B1 exists to prevent, reproduced inside the feature that prevents it.
 *
 * ── Why a structural test and not review ─────────────────────────────────────────────────────────
 * A fifth writer is one convenient `updateMany` away, and it would be invisible: nothing fails, the
 * product works, and a number in a report is quietly wrong months later. This spec fails the build
 * the moment a file writes either column without also building a transition.
 *
 * ── Detector shape ───────────────────────────────────────────────────────────────────────────────
 * Comments are stripped FIRST (the shared `stripComments`, feature 021): three guards written in one
 * day each tripped on their own retraction comments, and the note explaining why something was
 * removed is the most valuable line in the file. The scan also asserts it read a plausible number of
 * files — a guard that scans nothing reports a clean pass (feature 018's lesson).
 */
const SRC = join(__dirname, '..');

/** The columns whose every write must be accompanied by a transition. */
const GUARDED_COLUMNS = ['status', 'assignee_operator_id'] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'generated' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

/** A file writes a guarded column if it updates `conversation` with that column in the data. */
function writesGuardedColumn(source: string): boolean {
  const code = stripComments(source);
  // `conversation.update…({ … data: { status: … } })` in any spelling we actually use.
  if (!/\bconversation\s*\.\s*update(Many)?\s*\(/.test(code)) return false;
  return GUARDED_COLUMNS.some((col) => new RegExp(`\\b${col}\\s*:`).test(code));
}

/** …and it records one if it reaches the recorder, by either entry point. */
function recordsTransition(source: string): boolean {
  const code = stripComments(source);
  return /\b(buildStatement|\.record\s*\()/.test(code) || /TransitionRecorder/.test(code);
}

describe('every writer of conversation status/assignee records a transition', () => {
  const files = walk(SRC);

  it('scanned a plausible number of source files (guards against a vacuous pass)', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('its own detector works on planted samples', () => {
    expect(
      writesGuardedColumn(`db.conversation.updateMany({ where: {}, data: { status: 'open' } })`),
    ).toBe(true);
    expect(
      writesGuardedColumn(`db.conversation.updateMany({ data: { assignee_operator_id: null } })`),
    ).toBe(true);
    // Not a guarded write: a different table, and a different column.
    expect(writesGuardedColumn(`db.message.updateMany({ data: { status: 'x' } })`)).toBe(false);
    expect(writesGuardedColumn(`db.conversation.updateMany({ data: { priority: 'x' } })`)).toBe(
      false,
    );
    // A commented-out write must NOT count — this is why comments are stripped first.
    expect(writesGuardedColumn(`// db.conversation.updateMany({ data: { status: 'x' } })`)).toBe(
      false,
    );
  });

  it('no file writes a guarded column without recording a transition', () => {
    const offenders = files
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        return writesGuardedColumn(src) && !recordsTransition(src);
      })
      .map((f) => f.slice(SRC.length + 1).replace(/\\/g, '/'))
      .sort();

    // If this list is non-empty, the stream is INCOMPLETE — it will answer questions wrongly rather
    // than refuse them. Wire the writer; do not add it to an exemption list.
    expect(offenders).toEqual([]);
  });
});
