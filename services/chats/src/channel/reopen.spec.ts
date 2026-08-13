import { decideThreadOutcome } from './reopen';

/**
 * T037 (feature 033, US2) — **what a customer's reply does to a finished ticket** (FR-029).
 * FAILS before `reopen.ts` exists, PASSES after.
 *
 * The operator chose option A: *«Переоткрывать если пришел в старый»*. Two terminal categories, two
 * different answers, and the whole rule is four lines of pure code — so it is tested at its boundaries
 * rather than through a database.
 *
 * ⚠️ Every case here names a CATEGORY. Nothing in this file mentions a status word, because nothing in
 * `reopen.ts` may branch on one: a supervisor renaming *Solved* to *Готово* must not silently turn the
 * reopen rule off. `tests/statuses/no-status-key-branch.spec.ts` enforces that repo-wide; this asserts
 * the behaviour that rule protects.
 */
const MATCH = { conversationId: 'conv-7' };

describe('a reply on a live thread just joins it', () => {
  it.each(['new', 'open', 'pending', 'on_hold'] as const)('%s → append', (category) => {
    expect(decideThreadOutcome(MATCH, category)).toEqual({ kind: 'append', conversationId: 'conv-7' });
  });
});

describe('the two terminal categories are told apart (FR-029a/FR-029b)', () => {
  it('solved → REOPEN: a ticket the customer answered was not finished', () => {
    expect(decideThreadOutcome(MATCH, 'solved')).toEqual({ kind: 'reopen', conversationId: 'conv-7' });
  });

  it('closed → the ticket stays closed and a NEW one records what it continues', () => {
    // Reviving a closed ticket would return it to routing, restart an SLA clock against a date that has
    // passed, and change a closed-work number for a period already reported.
    expect(decideThreadOutcome(MATCH, 'closed')).toEqual({
      kind: 'continue',
      continuesConversationId: 'conv-7',
    });
  });
});

describe('the two cases where there is no answer to give', () => {
  it('nothing matched → a NEW ticket, never an attachment to the nearest guess (FR-031)', () => {
    expect(decideThreadOutcome(null, null)).toEqual({ kind: 'new' });
    // ⚠️ And still `new` even when a category is somehow supplied: the absence of a MATCH decides,
    // because there is no conversation to append to. A future edit that read the category first would
    // return `append` with no id — a defect a type check alone would not catch.
    expect(decideThreadOutcome(null, 'open')).toEqual({ kind: 'new' });
  });

  it('a matched ticket whose category cannot be resolved → CONTINUE, the only lossless answer', () => {
    // It can only arise from a defect (a hand-written UPDATE, a migration that missed a row). Of the
    // three possible answers, `append` may bury the reply in a terminal ticket and `new` loses the
    // thread link; `continue` surfaces the message AND keeps the connection.
    expect(decideThreadOutcome(MATCH, null)).toEqual({
      kind: 'continue',
      continuesConversationId: 'conv-7',
    });
  });
});
