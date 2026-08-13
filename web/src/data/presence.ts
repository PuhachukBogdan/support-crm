/**
 * The product's presence states — **one list, spelled once** (2026-08-10).
 *
 * The server's closed set is `online · transfers_only · away · offline` (feature 025; the gateway's
 * presence edge decodes exactly these four and refuses a fifth). It was spelled in the user menu
 * only, and the moment a second screen needed it — the ticket window's Assignee chooser, which says
 * who is at their desk before you hand work to them — that copy would have become the drift
 * `priorities.ts` documents at length. So it moved here first.
 *
 * ⓘ The order is the operator's own frame: most available to least. A chooser reads it top to bottom.
 *
 * ⚠️ `offline` is the FAIL-CLOSED value. Anything unrecognised — an older row, a state a future
 * feature adds, a decode that failed — must read as *not available for work*, never as `online`. The
 * gateway applies the same rule on its side of the wire.
 */
/**
 * ⚠️⚠️ **The four STATES are a closed set and belong in code. Their DISPLAY WORDS do not, and the
 * difference is enforced by a test that this file failed on its first day (2026-08-10).**
 *
 * `Break` · `Lunch` · `Meeting` · `VIP task` are rows in a **table** an administrator edits (ADR 0042
 * §7, `GET /presence/labels`). This file originally wrote `label: 'Break'` for `away`, and
 * `tests/contracts/presence-label-never-branched-on.spec.ts` failed exactly as designed: *"The seed
 * may name them; the product may not. A literal here is how an editable word quietly becomes a
 * constant."* The wording below is therefore the STATE's own plain word — a fallback for an account
 * that has configured no label — and `usePresenceLabels()` overlays the account's real ones on top.
 *
 * ⇒ If you are about to type one of those four words here, you are about to re-break that test, and
 * the guard is right: an admin renaming «Break» to «Обед» must change this product's screens, not
 * require a deploy.
 */
export const PRESENCE_CHOICES = [
  { state: 'online', label: 'On shift', hint: 'Work is routed to you' },
  { state: 'transfers_only', label: 'Transfers only', hint: 'Only handed-over work' },
  { state: 'away', label: 'Away', hint: 'Nothing new is routed to you' },
  { state: 'offline', label: 'Offline', hint: 'Signed off' },
] as const;

export type PresenceChoice = (typeof PRESENCE_CHOICES)[number]['state'];

/**
 * The dot's colour per state — semantic tokens only, never a hex (rule 6; `tokens.contract.test.ts`
 * fails the build on a literal). An unknown state gets the muted tone, matching the fail-closed rule.
 */
export const PRESENCE_TONE: Readonly<Record<string, string>> = {
  online: 'bg-success',
  transfers_only: 'bg-info',
  away: 'bg-warning',
  offline: 'bg-muted-foreground',
};

/**
 * What to CALL a state on screen. `''` for a state the product does not recognise — never a guess.
 *
 * ── Why this does NOT read the account's presence labels, though they exist ──────────────────────
 * ⚠️ Tried and reverted the same day (2026-08-10), because live data showed it was the wrong model.
 * A `PresenceLabel` row is a **preset with a reason** («Обед», «Совещание»), and several map to ONE
 * state: on the stand, `Break`+`Lunch` are both `away`, and `Meeting`+`VIP task` are both
 * `transfers_only`. So "use the account's label as the state's name" would have
 *  · silently dropped one of each pair, and
 *  · renamed the routing state `transfers_only` to «Meeting» — a REASON standing in for a BEHAVIOUR
 *    («only handed-over work reaches you»), which is a different fact.
 *
 * ⇒ The four states keep their own neutral wording here, and offering the account's presets as extra
 * choices is a separate feature (noted on W22 in the plan), not something to smuggle into a rename.
 * The contract this file broke on its first day is satisfied by the wording above being the STATE's
 * own word rather than a seeded label — not by reading the table.
 */
export function presenceLabel(state: string): string {
  return PRESENCE_CHOICES.find((c) => c.state === state)?.label ?? '';
}
