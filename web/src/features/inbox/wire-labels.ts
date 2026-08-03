/**
 * Wire values → what a person reads (feature 029).
 *
 * ⚠️ **Found in a real browser, on real data, after the screen's whole test suite was green.** The
 * gateway returns `CONVERSATION_STATUS_OPEN`; the Inbox rendered exactly that, lowercased, so the
 * Status column read **`conversation_status_open`**. Every Track-A test passed because the stub in
 * `test-support.ts` invented `status: 'open'` — a shape the server has never sent.
 *
 * ⇒ That is the mock-vs-real divergence the conformance suite exists to catch, one level up: the
 * transport was conformant, the **fixture data** was not. The stub now uses wire values.
 *
 * Kept as a pure function with its own test rather than inline in a cell, because the same
 * translation will be needed by every screen that shows a status.
 */

/**
 * ⭐ Relative time — "13 minutes ago", copied from Zendesk (`screenshots/views_2.png`).
 *
 * A queue is scanned for *how long something has been waiting*, and an absolute timestamp makes the
 * reader do that subtraction in their head, once per row. Zendesk shows the elapsed time; ours showed
 * `8/2/2026, 7:37:08 PM`.
 *
 * ⚠️ Falls back to the absolute date past a week: "6 weeks ago" is less useful than a date once the
 * number stops being something a person holds in their head.
 *
 * ⓘ `now` is a parameter, not `Date.now()` inside — a formatter that reads the clock cannot be tested
 * without freezing time, and this repository has no time-mocking convention.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  if (!iso) return '';
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  // A clock skew between browser and server must not produce "in 3 seconds" on a support queue.
  if (seconds < 45) return 'just now';

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;

  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`;

  return then.toLocaleDateString();
}

/** `CONVERSATION_STATUS_OPEN` → `open`. Anything unrecognised is returned lowercased, unchanged. */
export function statusFromWire(wire: string): string {
  if (!wire) return '';
  const stripped = wire.replace(/^CONVERSATION_STATUS_/, '');
  // An UNSPECIFIED status is "the server said nothing", which the column renders as not-set rather
  // than as a status called "unspecified".
  if (stripped === 'UNSPECIFIED') return '';
  return stripped.toLowerCase();
}
