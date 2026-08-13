/**
 * An envelope-free diagnostic: the error's CLASS, its `code` when it has one, and where it was thrown.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * ── Why this exists, and why it lives HERE ───────────────────────────────────────────────────────
 * The rule *"log the name, never the message"* is right and stays: a mail, IMAP or Redis error message can
 * quote a mailbox, a credential or a header, and on the inbound path a header carries a **customer's
 * address** (Principle IV). But `name` on a plain `new Error(...)` is the literal string `Error`, and most
 * errors on those paths are plain — so three different faults in one afternoon of W3's live round each
 * logged `mailbox reader: Error`, twelve times a minute, with nothing to act on.
 *
 * ⭐ **It was written in the worker and then needed again, in the same session, by feature 034's realtime
 * publisher — which logged `realtime publish failed: Error` and cost a live round to diagnose.** So it is
 * shared rather than re-derived: *two copies of a detector is one copy that is wrong*, the rule
 * `stripComments` moved here for at feature 021.
 *
 * ── What it adds, and why none of it can leak ────────────────────────────────────────────────────
 *  · the **class** — `TypeError`, `ReplyError`, a library's own subclass;
 *  · the **`code`** — a syscall or protocol code (`ECONNREFUSED`, `ETIMEDOUT`, `AUTHENTICATIONFAILED`,
 *    `NOAUTH`): a fact about a socket or a protocol, never about a person;
 *  · the **top frame in our own source** — `file:line`, the single most actionable field available and
 *    structurally incapable of holding an address, a subject or a body.
 *
 * ⚠️ Never the message. That is the whole point.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⇒ *Not logged* and *not diagnosable* are different requirements, and Principle IV only asks for the
 * first. A line that cannot distinguish three faults is the observability equivalent of a vacuous pass.
 */
export function diagnose(err: unknown): string {
  if (!(err instanceof Error)) return 'error';
  const parts = [err.constructor?.name || err.name];
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code !== '') parts.push(`code=${code}`);
  /**
   * The first frame that is ours: a library's internals are noise and `node_modules` paths are long.
   *
   * ⚠️ Both separators. A stack on Windows says `…\services\worker\…` and on Linux `…/services/worker/…`;
   * a hardcoded `/` finds nothing on a developer's box and works in the container, so the log would be
   * useful in exactly the place nobody is looking at it. (`tests/portability/no-hardcoded-path-separator`
   * guards the class, and this function was written wrong the first time anyway.)
   */
  const OURS = /[\\/](services|libs)[\\/]/;
  const frame = (err.stack ?? '')
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .find((l) => OURS.test(l) && !l.includes('node_modules'));
  if (frame) {
    const at = /\(?([^\s()]+:\d+:\d+)\)?$/.exec(frame);
    const where = at?.[1];
    if (where) parts.push(`at=${where.split(OURS).pop() ?? where}`);
  }
  return parts.join(' ');
}
