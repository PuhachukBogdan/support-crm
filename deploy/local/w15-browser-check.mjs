/**
 * W15 browser check — the Channels section of the Admin Center (subpoint 3.10, roadmap 6.8 minimum).
 *
 * Two roles again, because the claim has two halves:
 *   · the OWNER sees the table — brand names, kinds, the API-channel KEY («вижу ключ API-канала») —
 *     and changes a mail address through the form, watching the row update;
 *   · a TEAMLEAD opening the same page gets the refusal IN WORDS — never an empty table (W11's rule)
 *     and never a crash.
 *
 * Plus the standing anti-storm assertion on the page's key interaction (opening the address form).
 */
import { chromium } from 'playwright';
import { assertNoRenderStorm } from './lib/no-render-storm.mjs';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-beton.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.1:8025';
const ROLE_PW = process.env.ROLE_PASSWORD ?? 'Stand#Role7x';
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'mistydubteck@beton.win';
const OWNER_PW = process.env.OWNER_PASSWORD ?? '';
const RESTORE_ADDR = 'support-brand1@stand.test';

let ok = 0, bad = 0;
const pass = (m) => { ok += 1; console.log(`  PASS  ${m}`); };
const fail = (m, d) => { bad += 1; console.log(`  FAIL  ${m}${d ? ` — ${d}` : ''}`); };

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

async function openChannelsAs(email, password) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  await page.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(email));
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
  await page.goto(`${WEB}/admin/channels`, { waitUntil: 'networkidle', timeout: 20000 });
  return { page, browser, errors };
}

// ── the owner: the table, the key, and the one write ──────────────────────────────────────────────
const NEWADDR = `w15-ui-${Date.now()}@stand.test`;
try {
  const { page, browser, errors } = await openChannelsAs(OWNER_EMAIL, OWNER_PW);
  try {
    await page.waitForSelector('[data-testid="channels-list"]', { timeout: 20000 });
    pass('the owner signed in and the channels table rendered');

    const body = (await page.textContent('[data-testid="channels-list"]')) ?? '';
    if (body.includes('stand-api-brand1')) pass('⭐ the API-channel KEY is on the screen («вижу ключ API-канала»)');
    else fail('api key visible', body.slice(0, 120));

    // The email channel's change-address control — the page's key interaction, storm-checked.
    const changeBtn = await page.$('[data-testid^="change-address-"]');
    if (!changeBtn) {
      fail('an email channel with a change control', 'none rendered');
    } else {
      const testid = await changeBtn.getAttribute('data-testid');
      await assertNoRenderStorm({ page, selector: `[data-testid="${testid}"]`, pass, fail });
      const chId = testid.replace('change-address-', '');
      if (!(await page.$(`[data-testid="address-input-${chId}"]`))) await page.click(`[data-testid="${testid}"]`);
      await page.fill(`[data-testid="address-input-${chId}"]`, NEWADDR);
      await page.click(`[data-testid="address-save-${chId}"]`);
      await page.waitForFunction(
        (addr) => document.querySelector('[data-testid="channels-list"]')?.textContent?.includes(addr),
        NEWADDR,
        { timeout: 15000 },
      );
      pass(`⭐ the address was changed from the screen and the row is the receipt (${NEWADDR})`);

      // Restore through the same form, so the next run (and the stand) start where this one did.
      await page.click(`[data-testid="change-address-${chId}"]`);
      await page.fill(`[data-testid="address-input-${chId}"]`, RESTORE_ADDR);
      await page.click(`[data-testid="address-save-${chId}"]`);
      await page.waitForFunction(
        (addr) => document.querySelector('[data-testid="channels-list"]')?.textContent?.includes(addr),
        RESTORE_ADDR,
        { timeout: 15000 },
      );
      pass('…and restored the seeded address the same way');
    }

    if (errors.length === 0) pass('no uncaught page errors during the owner pass');
    else fail('page errors (owner)', errors[0]);
  } finally {
    await browser.close().catch(() => {});
  }
} catch (err) {
  fail('the owner pass could not run', err instanceof Error ? err.message : String(err));
}

// ── the teamlead: the refusal is words, not an empty table ────────────────────────────────────────
try {
  const { page, browser, errors } = await openChannelsAs('role-teamlead@beton.win', ROLE_PW);
  try {
    await page.waitForSelector('[data-testid="channels-error"]', { timeout: 20000 });
    const copy = (await page.textContent('[data-testid="channels-error"]')) ?? '';
    if (/do not have access/i.test(copy)) pass('⛔ a teamlead gets the refusal IN WORDS — never an empty table');
    else fail('worded refusal', copy.slice(0, 80));
    if (!(await page.$('[data-testid="channels-list"]'))) pass('⛔ …and no table is rendered at all');
    else fail('no table for teamlead', 'a table rendered beside the refusal');
    if (errors.length === 0) pass('no uncaught page errors during the teamlead pass');
    else fail('page errors (teamlead)', errors[0]);
  } finally {
    await browser.close().catch(() => {});
  }
} catch (err) {
  fail('the teamlead pass could not run', err instanceof Error ? err.message : String(err));
}

console.log(`\nW15 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
