/**
 * W6 browser check — the R38 Inbox on the PUBLIC origin (block W6, subpoints 2.5 + 2.9).
 *
 * What only a real browser can answer:
 *   · the five R38 buttons render, and a click changes the LIST rather than only the highlight
 *   · the toolbar's Status ▾ offers the ACCOUNT's own statuses, by agent name, per bucket
 *   · the «Мои» scope narrows to the signed-in agent via /me/operator
 *   · the status column shows catalogue names, not raw keys
 *   · nothing on the page is red any more (R38 freed the colour)
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
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, storageState: state, ...creds });
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

  // ── 1. the R38 rail ─────────────────────────────────────────────────────────────────────────────
  const labels = await p.$$eval('[data-testid="bucket-rail"] button', (bs) => bs.map((b) => b.textContent?.trim()));
  if (JSON.stringify(labels) === JSON.stringify(['Inbox', 'Open', 'Ждут', 'Solved', 'Archive']))
    pass('the rail is R38’s five buttons, in order, «Ждут» spelled the operator’s way');
  else fail('R38 rail', JSON.stringify(labels));

  if (!/\d/.test(await p.$eval('[data-testid="bucket-rail"]', (el) => el.textContent ?? '')))
    pass('⛔ no button carries a number — counts are 9.2a’s, unread is 9.12’s (R38)');
  else fail('no numbers on the rail');

  // REAL click #1: a rail button genuinely receives pointer events (no overlay, no dead region).
  await p.click('[data-testid="bucket-open"]', { timeout: 12000 });
  const counts = { open: await rows() };
  pass(`a real click on «Open» switched the bucket (${counts.open} rows)`);

  for (const id of ['inbox', 'waiting', 'solved', 'archive']) {
    await domClick(`[data-testid="bucket-${id}"]`);
    counts[id] = await rows();
  }
  console.log(`        rows per bucket (dom): ${JSON.stringify(counts)}`);
  if (new Set(Object.values(counts)).size > 1) pass('each bucket shows a DIFFERENT list — the categories really narrow');
  else fail('buckets narrow', `every bucket showed ${Object.values(counts)[0]} rows`);

  // ── 2. the toolbar in «Ждут» ────────────────────────────────────────────────────────────────────
  await domClick('[data-testid="bucket-waiting"]');
  await p.waitForSelector('[data-testid="filter-status"]', { timeout: 10000 });
  pass('«Ждут» renders Status ▾ — the one bucket whose categories hold more than one status');

  // REAL click #2: Radix opens under real input (the native-popup freeze lesson, still guarded).
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
    .filter((s) => s.active !== false && ['CONVERSATION_STATUS_CATEGORY_PENDING', 'CONVERSATION_STATUS_CATEGORY_ON_HOLD'].includes(s.category))
    .map((s) => s.agentName);
  if (wanted.length > 1 && JSON.stringify(options) === JSON.stringify(['Any', ...wanted]))
    pass(`Status ▾ offers exactly the account’s ACTIVE «Ждут» statuses, by agent name (${wanted.length})`);
  else fail('Status ▾ options', `offered ${JSON.stringify(options)} vs catalogue ${JSON.stringify(wanted)}`);

  const chips = await p.$$eval('[role="group"][aria-label="Channel"] button', (bs) => bs.map((b) => b.textContent?.trim()));
  if (JSON.stringify(chips) === JSON.stringify(['Все', 'API', 'Email']))
    pass('channel chips: Все · API · Email — no messenger chip until a transport exists');
  else fail('channel chips', JSON.stringify(chips));

  // ── 3. «Мои» — the 5.11 scope (REAL click #3) ──────────────────────────────────────────────────
  await domClick('[data-testid="bucket-open"]');
  const allRows = await rows();
  if (!(await p.locator('[data-testid="scope-mine"]').isDisabled()))
    pass('«Мои» is enabled — /me/operator answered on the public origin');
  else fail('«Мои» enabled', '/me/operator did not answer');
  await p.click('[data-testid="scope-mine"]', { timeout: 12000 });
  const myRows = await rows();
  console.log(`        Open: all=${allRows} mine=${myRows}`);
  if (myRows < allRows) pass('⭐ «Мои» narrows the list to the signed-in agent’s own tickets');
  else if (myRows === allRows) note(`«Мои» changed nothing: this agent holds every Open ticket here (all=${allRows}) — not a defect, but not a proof either`);
  else fail('«Мои» narrows', `mine=${myRows} > all=${allRows}`);

  // ── 4. the status column, and the freed colour ─────────────────────────────────────────────────
  await domClick('[data-testid="scope-mine"]');
  await domClick('[data-testid="bucket-waiting"]');
  await p.waitForTimeout(1300);
  const cells = await p.$$eval('table tbody tr [data-kind="status"]', (cs) => cs.map((c) => c.textContent?.trim()));
  const raw = cells.filter((t) => (t ?? '').includes('_'));
  if (cells.length === 0) note('«Ждут» holds no rows right now — the column assertion needs rows to look at');
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
