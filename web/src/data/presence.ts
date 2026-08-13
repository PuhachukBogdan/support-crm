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
export const PRESENCE_CHOICES = [
  { state: 'online', label: 'On shift', hint: 'Work is routed to you' },
  { state: 'transfers_only', label: 'Transfers only', hint: 'Only handed-over work' },
  { state: 'away', label: 'Break', hint: 'Nothing new is routed to you' },
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

/** The state's own label, or `''` when the product does not recognise it (never a guess). */
export function presenceLabel(state: string): string {
  return PRESENCE_CHOICES.find((c) => c.state === state)?.label ?? '';
}
