/**
 * The product's ticket priorities — **one list, spelled once** (2026-08-10).
 *
 * ── The drift this replaces ─────────────────────────────────────────────────────────────────────
 * The Inbox's filter offered `low · normal · high · urgent`; the owning service knows three
 * (`services/chats/src/shared/wire.ts` → `PRIORITIES`). `urgent` was never a priority any ticket
 * could hold, so filtering by it returned an empty list forever — and an empty list reads as *"no
 * urgent tickets right now"*, not as *"that word does not exist"*. Nothing failed; the screen simply
 * answered a question nobody could tell was unanswerable.
 *
 * It surfaced while building the ticket window's priority editor, because an editor cannot offer a
 * value the server refuses — a filter can, silently, which is why the filter carried it for longer.
 *
 * ⚠️ `priorities-match-the-service.test.ts` reads the service's own list as TEXT and fails if these
 * two disagree. Same mechanism as `nav-permissions.test.ts`, for the same reason: `web` must not take
 * a build dependency on a service, and a fixture that shares the code's assumption cannot test it.
 *
 * ⓘ The order is deliberate — least to most urgent, which is how the chooser reads top to bottom.
 * It is NOT the urgency rank: that is the service's (`urgency.ts`), maintained beside the column it
 * sorts, and deriving one from the other would tie a menu's layout to a queue's ordering.
 */
export const PRIORITIES = ['low', 'normal', 'high'] as const;

export type Priority = (typeof PRIORITIES)[number];

/** Sentence case for a screen. The stored value is always the lower-case key. */
export const PRIORITY_LABELS: Readonly<Record<Priority, string>> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
};

/** The chooser's options. `''` (no priority) is offered separately — see `EditableChoice.allowClear`. */
export const PRIORITY_OPTIONS: readonly { value: string; label: string }[] = PRIORITIES.map((p) => ({
  value: p,
  label: PRIORITY_LABELS[p],
}));
