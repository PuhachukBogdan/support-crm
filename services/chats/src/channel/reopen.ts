import { STATUS_CATEGORIES, type StatusCategory } from '@crm/common';

/**
 * What a customer's reply does to the ticket its thread belongs to (feature 033 — T042, FR-029).
 *
 * ── The rule, and why the CATEGORY decides it ────────────────────────────────────────────────────
 * The operator chose option A: *«Переоткрывать если пришел в старый»* — a reply revives a **solved**
 * ticket, and a **closed** one spawns a linked follow-up. Two terminal categories, two different
 * answers, and the difference is not cosmetic:
 *
 *   • **`solved`** — finished, not archived. The customer answering it is the strongest possible
 *     evidence that it was not finished, so it comes back into the agent's rail.
 *   • **`closed`** — final. Reviving it months later would put it back into routing, restart an SLA
 *     clock against a date that has passed, and change a closed-work number for a reporting period
 *     already reported. So the closed ticket is left exactly as it is and the reply becomes a NEW
 *     ticket that records what it continues.
 *
 * ⚠️ **Branching on the CATEGORY and never on a status word.** `libs/common/src/statuses/categories.ts`
 * states the premise: a status is per-account configuration and a supervisor may add *Waiting for
 * finance* without any code learning the word. A check for `status === 'solved'` would silently stop
 * working for an account that renamed it — and stop working in the direction that buries the customer's
 * reply in a ticket nobody is looking at. `tests/statuses/no-status-key-branch.spec.ts` enforces this as
 * a scan, because prose could not.
 *
 * ── Decision here, writes in the caller ─────────────────────────────────────────────────────────
 * This file is pure. It is the whole rule in fifteen readable lines, testable without a database — the
 * same split `subject.derive.ts` uses, and for the same reason: the rule is the part that has to be
 * obviously right.
 */

export type ThreadDecision =
  /** Nothing matched — a first contact, or a reply to a thread we do not hold (FR-031). */
  | { kind: 'new' }
  /** The thread is live. The message joins it and nothing about the ticket changes. */
  | { kind: 'append'; conversationId: string }
  /** `solved` → back into the rail, into a status from the account's own catalogue (FR-029a). */
  | { kind: 'reopen'; conversationId: string }
  /** `closed` → the ticket stays closed; a new one records what it continues (FR-029b). */
  | { kind: 'continue'; continuesConversationId: string };

/**
 * Decide from the matched ticket's category alone.
 *
 * @param match `null` when threading found nothing we hold.
 * @param category the category of the matched ticket's current status, or `null` when the stored status
 *        key resolves to no category the code knows.
 *
 * ⚠️ **An unresolvable category is treated as `continue`, and that choice is deliberate.** It can only
 * arise from a defect — a hand-written UPDATE, a migration that missed a row — and the three available
 * answers are not equally wrong:
 *
 *   • *append* would put the customer's words into a ticket that may be terminal, where nobody is
 *     looking. Silent, and the customer's silence afterwards is the only symptom.
 *   • *new* would lose the connection to the thread entirely — the irreversible split this whole file
 *     exists to prevent.
 *   • *continue* surfaces the message as a ticket an agent will see AND keeps the link to what it
 *     continues. It is the only one of the three that loses nothing.
 */
export function decideThreadOutcome(
  match: { conversationId: string } | null,
  category: StatusCategory | null,
): ThreadDecision {
  if (!match) return { kind: 'new' };

  if (category === null) return { kind: 'continue', continuesConversationId: match.conversationId };

  const spec = STATUS_CATEGORIES[category];

  // Non-terminal — being worked on, waiting for the customer, waiting on us. The reply just joins it.
  if (!spec.terminal) return { kind: 'append', conversationId: match.conversationId };

  // ⭐ **Read from the catalogue, not compared against a word.** `reopenOnCustomerReply` is a property of
  // the category in `libs/common/src/statuses/categories.ts`, and it is there because
  // `tests/statuses/no-status-key-branch.spec.ts` refused `category === 'solved'` — correctly, since
  // `solved` is simultaneously a category name and a seeded status KEY, so that comparison cannot be told
  // apart from the branching ADR 0040 forbids. A category added later brings its own answer as data.
  return spec.reopenOnCustomerReply
    ? { kind: 'reopen', conversationId: match.conversationId }
    : { kind: 'continue', continuesConversationId: match.conversationId };
}
