/**
 * ⭐⭐ THE ANTI-STORM ASSERTION — a STANDING RULE for every block's browser check (operator,
 * 2026-08-06: «заложи это правило во всё, что будет»).
 *
 * Why it exists: the Inbox freeze survived THREE green gates. A re-render storm renders
 * byte-identical HTML while the renderer burns (~23 000 scheduler posts across one bucket click,
 * ~9 000/s, for ever — then the tab dies with no JS error), and jsdom has neither layout nor commit
 * accounting, so 536 unit tests saw nothing all three times. Counting the real scheduler's posts in
 * a real browser is the ONLY assertion type that catches this class.
 *
 * How it measures: React's scheduler posts through a MessageChannel, so counting
 * `MessagePort.prototype.postMessage` calls is counting commits. Quiet is single digits; the limit
 * of 200 is two orders of magnitude of headroom below the defect's ~23 000.
 *
 * The rule (`cowork/mvp-plan.md`, «Тестовый минимум блока»): every block that ships or reworks a
 * page calls `assertNoRenderStorm` on that page's KEY interaction (the bucket/tab switch, the
 * open-a-ticket click — whatever the operator does most). One call, one line in the check.
 *
 * ⚠️ Runner note: check runners copy the .mjs into `/tmp/pw-work` file-by-file — the runner MUST
 * also copy `lib/` alongside (see `run-w6-browser-check.sh`), or the import fails only on the stand.
 */

/** Count React-scheduler posts across a DOM click on `selector`, over `settleMs` of settling. */
export async function schedulerPostsAcrossClick(page, selector, settleMs = 2500) {
  return page.evaluate(async ({ selector, settleMs }) => {
    let n = 0;
    const proto = MessagePort.prototype;
    const orig = proto.postMessage;
    proto.postMessage = function (...a) { n += 1; return orig.apply(this, a); };
    document.querySelector(selector)?.click();
    await new Promise((r) => setTimeout(r, settleMs));
    proto.postMessage = orig;
    return n;
  }, { selector, settleMs });
}

/**
 * The one-line form for a check: measures across a click and reports through the check's own
 * pass/fail. Returns the post count so a check can log it.
 */
export async function assertNoRenderStorm({ page, selector, pass, fail, settleMs = 2500, limit = 200 }) {
  const posts = await schedulerPostsAcrossClick(page, selector, settleMs);
  const secs = settleMs / 1000;
  if (posts < limit)
    pass(`⭐⭐ no re-render storm: ${posts} scheduler posts in ${secs}s across ${selector} (limit ${limit}; the Inbox defect was ~23 000)`);
  else fail('re-render storm', `${posts} scheduler posts in ${secs}s across ${selector} (limit ${limit})`);
  return posts;
}
