/**
 * W11 browser check — the customer directory on the PUBLIC origin (roadmap 9.17).
 *
 * What only a real browser answers:
 *   · the rail's Contacts entry now leads to the DIRECTORY, not the reserved-module placeholder
 *   · ⭐⭐ opening it causes no re-render storm (the standing rule, on this screen's key interaction)
 *   · the brand chooser renders and a row opens the player page at BOTH segments
 *   · the id search narrows the visible table
 *   · ⛔ nothing on the page offers a contact search
 *   · the table does not scroll sideways at the operator's 1920 (the density rule)
 *
 * ⚠️ Signed in as the TEAMLEAD role: a support agent is refused the directory by the server, which
 * is asserted on the wire in `live-w11.sh`. Using an agent here would prove the refusal and nothing
 * about the screen.
 */
import { chromium } from 'playwright';
import { assertNoRenderStorm } from './lib/no-render-storm.mjs';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-beton.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.1:8025';
const EMAIL = process.env.PROBE_EMAIL ?? 'role-teamlead@beton.win';
const PASS = process.env.PROBE_PASSWORD ?? 'Stand#Role7x';

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
  state = await ctx.storageState();
  pass('signed in as the teamlead role (the directory is refused to agents by the server)');
} catch (err) {
  fail('sign-in', err instanceof Error ? err.message : String(err));
} finally {
  await signer.close().catch(() => {});
}

if (!state) {
  console.log(`\nW11 browser: ${ok} ok, ${bad} failed`);
  process.exit(1);
}

const browser = await chromium.launch();
try {
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

  // ── 1. ⭐⭐ the anti-storm assertion on THIS screen's key interaction: opening the directory ─────
  const contactsLink = await p.$('a[href="/contacts"]');
  if (contactsLink) pass('the rail carries the Contacts entry');
  else fail('contacts nav entry', 'not rendered for this role');
  await assertNoRenderStorm({ page: p, selector: 'a[href="/contacts"]', pass, fail });

  await p.waitForSelector('[data-testid="brand-chooser"]', { timeout: 15000 });
  if (!(await p.$('[data-testid="module-coming-soon"]')))
    pass('/contacts is the DIRECTORY now — no reserved-module placeholder');
  else fail('directory replaces the placeholder');

  // ── 2. the table, and the density rule ─────────────────────────────────────────────────────────
  const rows = await p.$$eval('table tbody tr[data-index]', (rs) => rs.length);
  if (rows > 0) pass(`the directory lists customers (${rows} rows)`);
  else if (await p.$('[data-testid="dt-empty"]')) note('this brand has no customers on the stand — the empty state renders');
  else fail('directory rows', 'neither rows nor the empty state');

  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow <= 0) pass('⛔ the page does not scroll sideways at 1920 (the density rule)');
  else fail('horizontal scroll', `${overflow}px of overflow`);

  // ── 3. ⛔ no contact search anywhere on the screen ──────────────────────────────────────────────
  const labels = await p.$$eval('input', (els) => els.map((e) => `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('placeholder') ?? ''}`.toLowerCase()));
  const contactish = labels.filter((l) => /email|phone|mail|телефон|почт/.test(l));
  if (contactish.length === 0) pass('⛔ no input on the directory offers a contact search (0044 §4)');
  else fail('contact search present', contactish.join(' | '));

  // ── 4. the search narrows, and a row opens the page ────────────────────────────────────────────
  if (rows > 0) {
    const firstId = await p.$eval('table tbody tr[data-index] td', (td) => (td.textContent ?? '').trim());
    await p.fill('[data-testid="player-id-search"]', firstId.slice(0, 6));
    await p.$eval('[data-testid="player-id-search-go"]', (el) => el.click());
    await p.waitForTimeout(1200);
    const narrowed = await p.$$eval('table tbody tr[data-index]', (rs) => rs.length);
    if (narrowed > 0 && narrowed <= rows) pass(`the id search keeps the match (${rows} → ${narrowed} rows)`);
    else fail('search keeps the match', `${rows} → ${narrowed}`);

    // ⚠️ The line above is WEAK on a stand with two similarly-named players — "2 → 2" proves the
    // search did not break, not that it narrows. So: a prefix nobody matches must EMPTY the table
    // and say why. That one cannot pass by accident.
    await p.fill('[data-testid="player-id-search"]', 'zzz-nobody');
    await p.$eval('[data-testid="player-id-search-go"]', (el) => el.click());
    await p.waitForTimeout(1200);
    const none = await p.$$eval('table tbody tr[data-index]', (rs) => rs.length);
    const emptyText = (await p.$eval('[data-testid="dt-empty"]', (el) => el.textContent ?? '').catch(() => '')) || '';
    if (none === 0 && /ID prefix/i.test(emptyText))
      pass('⭐ a prefix nobody matches empties the table AND says it was the search, not the brand');
    else fail('search narrows to nothing', `rows=${none} empty="${emptyText.slice(0, 60)}"`);

    await p.$eval('[data-testid="player-id-search-clear"]', (el) => el.click());
    await p.waitForTimeout(800);
    await p.$eval('table tbody tr[data-index]', (tr) => tr.click());
    await p.waitForSelector('[data-testid="player-page-identity"]', { timeout: 15000 });
    const url = p.url();
    if (/\/players\/[^/]+\/[^/]+$/.test(url)) pass('a row opens the player page at BOTH segments (brand + id)');
    else fail('player page url', url);
    if (await p.$('[data-testid="player-page-gr8"]')) pass('the page says plainly that GR8 data is not held yet');
    else fail('gr8 block on the page');
  } else {
    note('no rows on this stand — the search and open-the-page legs are skipped, and say so');
  }

  if (errors.length === 0) pass('no uncaught page errors during the whole pass');
  else fail('page errors', errors[0]);
} catch (err) {
  fail('the interaction pass could not run', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW11 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
