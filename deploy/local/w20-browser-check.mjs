/**
 * W20 browser check — Analytics as a person sees it (6.2 + 6.3 + 6.4).
 *
 * A teamlead has Analytics on the rail (the slot flipped active), the tiles carry NUMBERS, the
 * chart draws bars with exact values on hover, the parking-lot list is there; a line agent has no
 * rail entry and the typed URL answers in words. Anti-storm on the navigation into the page.
 */
import { chromium } from 'playwright';
import { assertNoRenderStorm } from './lib/no-render-storm.mjs';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-beton.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.1:8025';
const ROLE_PW = process.env.ROLE_PASSWORD ?? 'Stand#Role7x';

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

async function signIn(browser, email) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', ROLE_PW);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  await page.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(email));
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
  return { page, ctx, errors };
}

const browser = await chromium.launch();
try {
  // ── the teamlead: the numbers, the chart, the parking lot ────────────────────────────────────────
  const { page, ctx, errors } = await signIn(browser, 'role-teamlead@beton.win');
  await page.waitForSelector('nav a, aside a', { timeout: 20000 });
  if (await page.$('a[href="/analytics"]')) pass('⭐ Analytics is on the teamlead’s rail — the slot flipped active');
  else fail('analytics on the rail', 'no link');

  // The standing anti-storm assertion, on the navigation INTO the page (its key interaction).
  await assertNoRenderStorm({ page, selector: 'a[href="/analytics"]', pass, fail });
  await page.waitForSelector('[data-testid="stat-tiles"]', { timeout: 20000 });
  pass('the tiles rendered');

  const created = (await page.textContent('[data-testid="stat-created-today"]')) ?? '';
  if (/\d/.test(created)) pass(`…and «создано сегодня» is a NUMBER (${created.replace(/\D+/g, ' ').trim()})`);
  else fail('created-today numeric', created.slice(0, 40));

  // Шаг 1: the chart is the LIBRARY's (Recharts under shadcn's ChartContainer) — the bars are SVG
  // rectangles now, and the hover is a real tooltip. These are exactly the claims the jsdom test
  // surrendered (it has no layout to draw them), so they live here or nowhere.
  if (await page.$('[data-testid="volume-chart"] [data-chart]')) pass('⭐ the chart is the library’s (ChartContainer mounted)');
  else fail('library chart mounted', 'no [data-chart] under volume-chart');
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="volume-chart"] .recharts-bar-rectangle').length >= 14,
    { timeout: 15000 },
  );
  const bars = await page.$$eval('[data-testid="volume-chart"] .recharts-bar-rectangle', (els) => els.length);
  pass(`⭐ the chart draws one bar per day (${bars} SVG bars — a zero day is a stub, not a hole)`);
  // Hover the LAST bar's center; the tooltip must carry the date and the exact count.
  const barBox = await page
    .locator('[data-testid="volume-chart"] .recharts-bar-rectangle')
    .last()
    .boundingBox();
  if (barBox) {
    await page.mouse.move(barBox.x + barBox.width / 2, barBox.y + Math.max(1, barBox.height / 2));
    await page.waitForTimeout(400);
    const tip = (await page.textContent('[data-testid="volume-chart"] .recharts-tooltip-wrapper')) ?? '';
    if (/20\d\d-\d\d-\d\d/.test(tip) && /\d/.test(tip.replace(/20\d\d-\d\d-\d\d/, '')))
      pass(`…hover raises the library tooltip with the date and the value (“${tip.trim().slice(0, 40)}”)`);
    else fail('chart tooltip', tip.slice(0, 60) || 'empty');
  } else fail('chart tooltip', 'no bar box to hover');
  // Rule 11: both themes, seen. The shots land beside the run for the human pass.
  const SHOTS = process.env.SHOT_DIR ?? '/tmp/pw-work/shots';
  await page.screenshot({ path: `${SHOTS}/w20-analytics-light.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => {
    document.documentElement.classList.add('dark');
  });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/w20-analytics-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  pass('analytics screenshots taken, light and dark');

  if (await page.$('[data-testid="pending-by-agent"]')) pass('the parking-lot list (6.4) is on the page');
  else fail('pending list', 'missing');

  if (errors.length === 0) pass('no uncaught page errors during the teamlead pass');
  else fail('page errors (teamlead)', errors[0]);
  await ctx.close();

  // ── the agent: no rail entry, a worded refusal by URL ───────────────────────────────────────────
  const agent = await signIn(browser, 'role-support-agent@beton.win');
  await agent.page.waitForSelector('nav a, aside a', { timeout: 20000 });
  if (!(await agent.page.$('a[href="/analytics"]'))) pass('⛔ a line agent’s rail has NO Analytics');
  else fail('analytics hidden from agent rail', 'link rendered');
  await agent.page.goto(`${WEB}/analytics`, { waitUntil: 'networkidle', timeout: 20000 });
  await agent.page.waitForSelector('[data-testid="analytics-error"]', { timeout: 20000 });
  pass('⛔ …and the typed URL answers in WORDS — never an empty dashboard');
  await agent.ctx.close();
} catch (err) {
  fail('the pass could not run', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW20 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
