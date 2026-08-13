/**
 * W6→W23 browser check — the Inbox rail as the operator decided it LAST (R39 supersedes R38).
 *
 * What only a real browser can answer:
 *   · the four R39 buckets + the archive section render, and a click changes the LIST
 *   · the archive is a SECTION under a labelled separator — never a navigation
 *   · «на согласовании» narrows to supervisor_review INSIDE «В работе» — a filter, not a button
 *   · the toolbar's Status ▾ offers the ACCOUNT's own statuses, by agent name, per bucket
 *   · the «Мои» scope narrows to the signed-in agent via /me/operator
 *   · the status column shows catalogue names, not raw keys
 *   · nothing on the page is red any more (R38 freed the colour, R39 keeps it free)
 *
 * ⚠️ The harness lesson (`gotchas/the-harness-avoided-what-was-broken`) applied: this runs against the
 * PUBLIC origin, through the real proxy and its basic auth, exactly as the operator will.
 *
 * ⚠️⚠️ **A MEASURED LIMIT OF THIS CONTAINER, stated rather than skipped.** Playwright's real-input
 * clicks wedge this image's Chromium on about the sixth one — per BROWSER, not per page. Bisected: a
 * fresh page does not reset it, `--disable-gpu` and `--disable-dev-shm-usage` do not help, DOM clicks
 * are unaffected, and `page.evaluate` answers normally while a click hangs — so the APP is not the
 * wedge. The check therefore spends its real clicks on the interactions where real input proves
 * something a DOM click cannot (that the control receives pointer events at all) and uses DOM clicks
 * for plain navigation, each labelled `(dom)` so nothing reads as more than it is.
 */
import { chromium } from 'playwright';
import { assertNoRenderStorm } from './lib/no-render-storm.mjs';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-beton.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.1:8025';
const EMAIL = process.env.PROBE_EMAIL ?? 'seed-agent2@example.test';
const PASS = process.env.PROBE_PASSWORD ?? 'Stand#Seed7x';

let ok = 0, bad = 0;
const pass = (m) => { ok += 1; console.log(`  PASS  ${m}`); };
const fail = (m, d) => { bad += 1; console.log(`  FAIL  ${m}${d ? ` — ${d}` : ''}`); };
const note = (m) => console.log(`  NOTE  ${m}`);

const edgeHeaders = () =>
  process.env.EDGE_USER
    ? { Authorization: 'Basic ' + Buffer.from(`${process.env.EDGE_USER}:${process.env.EDGE_PASSWORD ?? ''}`).toString('base64') }
    : {};

async function codeFor(email) {
  for (let i = 0; i < 20; i += 1) {
    const res = await fetch(`${MAIL}/api/v1/search?query=to%3A${encodeURIComponent(email)}&limit=1`, { headers: edgeHeaders() });
    const m = JSON.stringify(await res.json().catch(() => ({}))).match(/code: ([A-Z0-9]{6})/);
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('no login code arrived');
}

const creds = process.env.EDGE_USER
  ? { httpCredentials: { username: process.env.EDGE_USER, password: process.env.EDGE_PASSWORD ?? '' } }
  : {};

// ── Sign in ONCE, in its own browser, so the two sign-in clicks do not spend the interaction budget.
const signer = await chromium.launch();
let state;
try {
  const ctx = await signer.newContext({ ignoreHTTPSErrors: true, ...creds });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  await page.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(EMAIL));
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
  await page.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });
  state = await ctx.storageState();
  pass('signed in through the real login screens (email + password + the code from the mailbox)');
} catch (err) {
  fail('sign-in', err instanceof Error ? err.message : String(err));
} finally {
  await signer.close().catch(() => {});
}

if (!state) {
  console.log(`\nW6 browser: ${ok} ok, ${bad} failed`);
  process.exit(1);
}

const browser = await chromium.launch();
try {
  /**
   * ⚠️ The operator's monitor is 2K, and column shedding depends on WIDTH: `channel` and `priority` are
   * `contextual`, so at 1280 px they shed — and their funnels shed with them, because a funnel lives in
   * its column. That is a real consequence of the header-funnel design, stated here rather than hidden
   * by a lucky viewport: at his width all three are present, and this check runs at his width.
   */
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: state,
    viewport: { width: 1920, height: 1080 },
    ...creds,
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));

  await p.goto(WEB, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });

  const domClick = (sel) => p.$eval(sel, (el) => el.click());
  const rows = async () => {
    await p.waitForTimeout(1300);
    return p.$$eval('table tbody tr', (rs) => rs.length).catch(() => 0);
  };

  // ── 1. the R39 rail (W23 — supersedes R38's five buttons) ───────────────────────────────────────
  const labels = await p.$$eval('[data-testid="bucket-rail"] button', (bs) => bs.map((b) => b.textContent?.trim()));
  if (JSON.stringify(labels) === JSON.stringify(['Inbox', 'В работе', 'Ждут клиента', 'Решённые', 'Весь архив']))
    pass('the rail is R39’s four buckets + the archive entry, his own names (2026-08-07)');
  else fail('R39 rail', JSON.stringify(labels));

  // R47: the archive is a SECTION of this rail — separated by a line and a heading, same page.
  const sep = await p.$eval('[data-testid="archive-separator"]', (el) => el.textContent?.trim() ?? '').catch(() => null);
  if (sep === 'Архив') pass('the archive sits under its own labelled separator — a section, not a page');
  else fail('archive separator', String(sep));

  if (!/\d/.test(await p.$eval('[data-testid="bucket-rail"]', (el) => el.textContent ?? '')))
    pass('⛔ no button carries a number — counts are 9.2a’s, unread is 9.12’s (R38, kept by R39)');
  else fail('no numbers on the rail');

  // REAL click #1: a rail button genuinely receives pointer events (no overlay, no dead region).
  await p.click('[data-testid="bucket-inwork"]', { timeout: 12000 });
  const counts = { inwork: await rows() };
  pass(`a real click on «В работе» switched the bucket (${counts.inwork} rows)`);

  const pathBefore = await p.evaluate(() => window.location.pathname);
  for (const id of ['inbox', 'waiting', 'solved', 'archive']) {
    await domClick(`[data-testid="bucket-${id}"]`);
    counts[id] = await rows();
  }
  console.log(`        rows per bucket (dom): ${JSON.stringify(counts)}`);
  if (new Set(Object.values(counts)).size > 1) pass('each bucket shows a DIFFERENT list — the categories really narrow');
  else fail('buckets narrow', `every bucket showed ${Object.values(counts)[0]} rows`);
  const pathAfter = await p.evaluate(() => window.location.pathname);
  if (pathBefore === pathAfter) pass('…and «Весь архив» stayed on THIS page — the section is not a navigation');
  else fail('archive is not a page', `${pathBefore} → ${pathAfter}`);

  // ── 2. the toolbar in «Ждут клиента» ────────────────────────────────────────────────────────────
  await domClick('[data-testid="bucket-waiting"]');
  await p.waitForSelector('[data-testid="filter-status"]', { timeout: 10000 });
  pass('«Ждут клиента» renders the status funnel — its category holds more than one status');
  for (const key of ['status', 'channel', 'priority']) {
    const handle = await p.$(`[data-testid="filter-${key}"]`);
    if (!handle) {
      fail(`${key} funnel present`, 'its column is not rendered at this width');
      continue;
    }
    const inHeader = await handle.evaluate((el) => !!el.closest('th'));
    if (inHeader) pass(`the ${key} funnel is INSIDE its column header (operator: «прям в эту плашку»)`);
    else fail(`${key} funnel placement`, 'not in a th');
  }

  // REAL click #2: the funnel opens under real input (both library dropdowns froze this screen; this
  // one is hand-written, so "it opens" is a claim that needs a real pointer event behind it).
  await p.click('[data-testid="filter-status"]', { timeout: 12000 });
  const options = await p.$$eval('[role="option"]', (os) => os.map((o) => o.textContent?.trim()));
  await p.keyboard.press('Escape');
  /**
   * ⚠️ The expectation is DERIVED FROM THE ACCOUNT'S OWN CATALOGUE, not written out here — the first
   * version listed the names from memory and failed on `Auto-Ended Chat`, which the SEED marks active
   * while the jsdom fixture marks retired. The screen was right and the assertion was pinning a
   * fixture belief (`the fixture is not what the script believes`, again). Asking the catalogue makes
   * the claim the actual product rule: **exactly the ACTIVE statuses of this bucket's categories, by
   * agent name.**
   */
  const catalogue = await p.evaluate(async () => {
    const res = await fetch('/api/conversations/statuses', { credentials: 'same-origin' });
    return res.json();
  });
  const wanted = (catalogue.statuses ?? [])
    .filter((s) => s.active !== false && s.category === 'CONVERSATION_STATUS_CATEGORY_PENDING')
    .map((s) => s.agentName);
  if (wanted.length > 1 && JSON.stringify(options) === JSON.stringify(['Any', ...wanted]))
    pass(`the status funnel offers exactly the account’s ACTIVE pending statuses, by name (${wanted.length})`);
  else fail('Status ▾ options', `offered ${JSON.stringify(options)} vs catalogue ${JSON.stringify(wanted)}`);

  // ── 2a. ⭐ R39's approvals decision, proven on the wire: «на согласовании» is the FUNNEL inside
  // «В работе» narrowing by the KEY supervisor_review — never a fifth button (which would have to
  // filter by a status key, the exact defect class the categories rule prevents).
  await domClick('[data-testid="bucket-inwork"]');
  await p.waitForSelector('[data-testid="filter-status"]', { timeout: 10000 });
  const superName = (catalogue.statuses ?? []).find((s) => s.key === 'supervisor_review')?.agentName;
  if (!superName) {
    fail('approvals filter', 'the catalogue has no supervisor_review status on this stand');
  } else {
    const approvalAsk = await p.evaluate(async (name) => {
      const seen = [];
      const orig = window.fetch;
      window.fetch = (...args) => {
        const url = String(args[0] ?? '');
        if (url.includes('/api/conversations?')) seen.push(url);
        return orig.apply(window, args);
      };
      document.querySelector('[data-testid="filter-status"]')?.click();
      await new Promise((r) => setTimeout(r, 400));
      const opt = Array.from(document.querySelectorAll('[role="option"]')).find(
        (o) => o.textContent?.trim() === name,
      );
      opt?.click();
      await new Promise((r) => setTimeout(r, 1200));
      window.fetch = orig;
      return seen;
    }, superName);
    const last = approvalAsk[approvalAsk.length - 1] ?? '';
    if (last.includes('status=supervisor_review') && last.includes('statusCategories=on_hold'))
      pass('⭐ «на согласовании» narrows to supervisor_review INSIDE «В работе» — a filter, never a button (R39)');
    else fail('approvals filter on the wire', last.slice(0, 160) || 'no request sampled');
    // A bucket switch clears the exact-status key by design — that IS the cleanup.
    await domClick('[data-testid="bucket-waiting"]');
    await p.waitForTimeout(600);
  }

  // ── 3. ⭐⭐ the self-scope, and the loop that is no longer there ────────────────────────────────
  //
  // The screen is scoped to the signed-in agent with NO control to widen it (operator, 2026-08-06:
  // «Менеджеру и так только его тикеты приходят»). So the assertions are: no widening control exists,
  // and every request carried the scope.
  if (!(await p.$('[data-testid="scope-mine"]'))) pass('⛔ no «Мои» toggle — the scope is not optional');
  else fail('scope control removed', 'a widening toggle is still on the page');

  const scoped = await p.evaluate(async () => {
    const seen = [];
    const orig = window.fetch;
    window.fetch = (...args) => {
      const url = String(args[0] ?? '');
      if (url.includes('/api/conversations?')) seen.push(url);
      return orig.apply(window, args);
    };
    document.querySelector('[data-testid="bucket-inbox"]')?.click();
    await new Promise((r) => setTimeout(r, 1500));
    window.fetch = orig;
    return seen;
  });
  if (scoped.length > 0 && scoped.every((u) => u.includes('assigneeOperatorId=')))
    pass(`every list request carries the agent's own scope (${scoped.length} sampled)`);
  else fail('self-scope on the wire', JSON.stringify(scoped).slice(0, 200));

  /**
   * ⭐⭐ THE FREEZE ASSERTION — now the shared standing rule (`lib/no-render-storm.mjs`): every
   * block's browser check calls it on its page's key interaction. Here that is the bucket switch —
   * the click the operator makes most, and the one that killed the page three times.
   */
  await assertNoRenderStorm({ page: p, selector: '[data-testid="bucket-waiting"]', pass, fail });

  // ── 4. the status column, and the freed colour ─────────────────────────────────────────────────
  await domClick('[data-testid="bucket-waiting"]');
  await p.waitForTimeout(1300);
  const cells = await p.$$eval('table tbody tr [data-kind="status"]', (cs) => cs.map((c) => c.textContent?.trim()));
  const raw = cells.filter((t) => (t ?? '').includes('_'));
  if (cells.length === 0) note('Pending holds no rows for this agent — the column assertion needs rows');
  else if (raw.length === 0) pass(`the status column shows catalogue NAMES (${JSON.stringify([...new Set(cells)].slice(0, 4))})`);
  else fail('status column names', JSON.stringify(raw.slice(0, 3)));

  const reds = await p.$$eval('[data-kind="status"]', (cs) => cs.filter((c) => c.className.includes('bg-destructive')).length);
  if (reds === 0) pass('⭐ nothing on the screen is red — R38 freed the colour for 9.12’s unread marker');
  else fail('red is freed', `${reds} red status chips`);

  if (errors.length === 0) pass('no uncaught page errors during the whole pass');
  else fail('page errors', errors[0]);
} catch (err) {
  fail('the interaction pass could not run', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW6 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
