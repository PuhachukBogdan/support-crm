/**
 * ⭐ Feature 037 (roadmap 4.15 — W30, US4): the U9 writer-precedence lock, as a PREDICATE.
 *
 * ── The rule, stated once ────────────────────────────────────────────────────────────────────────
 * An explicit human act — an operator editing the ticket, or invoking a macro (deliberate, feature
 * 023's own reasoning) — always wins and LOCKS classification: `classified_by` becomes the operator
 * id. An automated writer (an automation rule today, the auto-classifier at 15.2) may write only
 * what no human has set: its WHERE carries the lock, so a locked row matches zero rows and the
 * write is a structural no-op — never a check some caller forgot.
 *
 * ── Why a predicate and not a read-then-write ────────────────────────────────────────────────────
 * Until W30 this rule lived in comments beside an unconditional `updateMany` — the exact gap the
 * subject lock closed for titles («a locked row matches zero rows», roadmap 4.18). A predicate
 * cannot be forgotten by the next caller, because the next caller gets it from here.
 *
 * Pure functions, no I/O — the macros/automations appliers and the fields writes all build their
 * statements from these two.
 */

/**
 * The actor shape, structurally compatible with `TransitionActor` (feature 023). `kind` is a
 * string on purpose: the lock's question is binary — a HUMAN (`'user'`) said this, or something
 * else did (`'system'`, a future `'customer'`, anything) — and every non-human kind is automated.
 */
export interface ClassificationActor {
  kind: string;
  ref: string;
}

/**
 * The stored marker for a non-human classifier. `'ai'` predates this feature (ADR 0027 reserved the
 * column with it) — automations reuse it rather than minting a second automated mark, because the
 * lock's question is binary: did a HUMAN say this, or not.
 */
export const AUTOMATED_CLASSIFIER_MARK = 'ai';

/** What this write stamps into `classified_by`: the human's id, or the automated mark. */
export function classifiedByOf(actor: ClassificationActor): string {
  return actor.kind === 'user' ? actor.ref : AUTOMATED_CLASSIFIER_MARK;
}

/**
 * The WHERE-extension of a classification write. Empty for a human (always wins); for an automated
 * writer, matches only rows no human has locked (`classified_by` NULL or the automated mark).
 */
export function classificationLock(actor: ClassificationActor): Record<string, unknown> {
  return actor.kind === 'user'
    ? {}
    : { OR: [{ classified_by: null }, { classified_by: AUTOMATED_CLASSIFIER_MARK }] };
}
