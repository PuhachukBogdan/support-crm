/**
 * ⭐⭐ **SPLIT SOURCE INTO LINES WITHOUT THE CARRIAGE RETURN** — and the reason is a scar, not tidiness.
 *
 * ── What went wrong (found 2026-08-13, by CI, on its first run in 130 commits) ────────────────────
 * A structural guard in `services/chats` scanned each line for an interpolated RpcException message:
 *
 *     const RPC_MESSAGE = /message:\s*(.+)$/;
 *     readFileSync(file, 'utf8').split('\n').forEach((line) => { … RPC_MESSAGE.exec(line) … });
 *
 * On a Windows working tree every line still ends with `\r` after that split — and in JavaScript **`.`
 * does not match `\r`** (it is a line terminator, like `\n`). With `$` anchored at end-of-string, `(.+)$`
 * therefore cannot reach the end of the line, the regex matches **nothing at all**, and the guard reports
 * an empty offender list for every file it reads. It had been asserting nothing for weeks on the machine
 * where the work happens, while passing.
 *
 * CI checks out LF, so the same guard fired there the first time it ran and named a real violation. Two
 * different verdicts from the same commit, and the honest reading is not «CI is flaky» — it is **the local
 * gate was blind**.
 *
 * ⚠️ It also defeated a Linux rehearsal: `git archive` from a Windows working copy carries that copy's
 * line endings, so a container run over that tree stayed just as blind. A rehearsal has to normalise, or
 * it reproduces the wrong machine.
 *
 * ── Why a shared helper rather than a `\r` in each regex ─────────────────────────────────────────
 * `tests/data-model/assignment-history-is-additive.spec.ts` already knew — it strips `\r` itself. One
 * guard knowing and five not is exactly the shape this folder exists to remove: *a detector copied three
 * times is a detector that is wrong in at least one of them.* Anchoring is legitimate and useful; what
 * must not be per-file is remembering the platform.
 *
 * Pure: no I/O. Callers still read the file — this only decides what a «line» is.
 */
export function sourceLines(text: string): string[] {
  // `\r\n` and a lone `\r` (classic Mac line endings still appear in pasted fixtures) both terminate a
  // line, and neither leaves anything behind for an anchored pattern to trip over.
  return text.split(/\r\n|\n|\r/);
}
