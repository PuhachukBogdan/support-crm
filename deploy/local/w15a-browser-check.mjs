/**
 * W15a browser check — Ticket statuses in the Admin Center (subpoint 3.14; frame admin-center/068).
 *
 * Two roles, because this screen splits READ and WRITE across two keys:
 *   · the OWNER sees the catalogue grouped by category, CREATES a status from the form, edits its
 *     agent-facing name, retires it — each with the refreshed list as the receipt;
 *   · a TEAMLEAD sees the same catalogue (it is the vocabulary their inbox is labelled with) and
 *     has NO write control anywhere — absent, not disabled.
 *
 * Plus the standing anti-storm assertion on the page's key interaction (the create toggle).
 */
import { chromium } from 'playwright';
import { assertNoRenderStorm } from './lib/no-render-storm.mjs';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-beton.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.1:8025';
const ROLE_PW = process.env.ROLE_PASSWORD ?? 'Stand#Role7x';
const OWNER_EMAIL = process.env.OWNER_EMAIL ?? 'mistydubteck@beton.win';
const OWNER_PW = process.env.OWNER_PASSWORD ?? '';

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

async function openStatusesAs(email, password) {
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
  await page.goto(`${WEB}/admin/statuses`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForSelector('[data-testid^="category-"]', { timeout: 20000 });
  return { page, browser, errors };
}

// ── the owner: create → edit → retire, each receipted by the list ─────────────────────────────────
const STAMP = Date.now();
const NAME = `Browser Probe ${STAMP}`;
const KEY = `browser_probe_${STAMP}`;
try {
  const { page, browser, errors } = await openStatusesAs(OWNER_EMAIL, OWNER_PW);
  try {
    pass('the owner signed in and the catalogue rendered, grouped by category');

    const dual = (await page.textContent('[data-testid="category-new"]').catch(() => '')) ?? '';
    if (dual.length > 0) pass('…the “new” category section is there (the seeded vocabulary renders)');
    else fail('seeded categories render', 'category-new empty');

    // ⭐⭐ The standing anti-storm assertion, on the page's key interaction.
    await assertNoRenderStorm({ page, selector: '[data-testid="status-create-open"]', pass, fail });

    if (!(await page.$('[data-testid="status-create-form"]'))) await page.click('[data-testid="status-create-open"]');
    await page.waitForSelector('[data-testid="status-create-category"]', { timeout: 5000 });
    await page.click('[data-testid="status-create-category"]');
    await page.click('[role="menuitem"]:has-text("pending")');
    await page.fill('[data-testid="status-create-agent-name"]', NAME);
    await page.fill('[data-testid="status-create-end-user-name"]', 'In review');
    await page.click('[data-testid="status-create-save"]');
    await page.waitForSelector(`[data-testid="status-${KEY}"]`, { timeout: 15000 });
    const parent = await page.$(`[data-testid="category-pending"] [data-testid="status-${KEY}"]`);
    if (parent) pass(`⭐ created from the screen and it appears UNDER ITS CATEGORY (${KEY} in pending)`);
    else fail('created status grouped by category', 'row not inside category-pending');

    // Edit the agent-facing name; the row is the receipt.
    await page.click(`[data-testid="status-edit-${KEY}"]`);
    await page.fill(`[data-testid="edit-agent-name-${KEY}"]`, `${NAME} v2`);
    await page.click(`[data-testid="status-save-${KEY}"]`);
    await page.waitForFunction(
      (key) => document.querySelector(`[data-testid="status-${key}"]`)?.textContent?.includes('v2'),
      KEY,
      { timeout: 15000 },
    );
    pass('⭐ renamed from the screen — the key beside the new name did not move');

    // Retire — the badge that explains itself, and the probe's own cleanup.
    await page.click(`[data-testid="status-toggle-${KEY}"]`);
    await page.waitForSelector(`[data-testid="retired-${KEY}"]`, { timeout: 15000 });
    const badge = (await page.textContent(`[data-testid="retired-${KEY}"]`)) ?? '';
    if (/old tickets keep the label/.test(badge)) pass('⭐ retired from the screen, and the badge says what that MEANS');
    else fail('retired badge copy', badge.slice(0, 80));

    if (errors.length === 0) pass('no uncaught page errors during the owner pass');
    else fail('page errors (owner)', errors[0]);
  } finally {
    await browser.close().catch(() => {});
  }
} catch (err) {
  fail('the owner pass could not run', err instanceof Error ? err.message : String(err));
}

// ── the teamlead: the same catalogue, read-only by ABSENCE ────────────────────────────────────────
try {
  const { page, browser, errors } = await openStatusesAs('role-teamlead@beton.win', ROLE_PW);
  try {
    pass('a teamlead signed in and sees the catalogue (it labels their own inbox)');
    const controls = await page.$$eval(
      '[data-testid="status-create-open"], [data-testid^="status-edit-"], [data-testid^="status-toggle-"]',
      (els) => els.length,
    );
    if (controls === 0) pass('⛔ …and has NO write control anywhere — absent, not disabled');
    else fail('write controls hidden from teamlead', `${controls} rendered`);
    if (errors.length === 0) pass('no uncaught page errors during the teamlead pass');
    else fail('page errors (teamlead)', errors[0]);
  } finally {
    await browser.close().catch(() => {});
  }
} catch (err) {
  fail('the teamlead pass could not run', err instanceof Error ? err.message : String(err));
}

console.log(`\nW15a browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
