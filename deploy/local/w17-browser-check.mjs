/**
 * W17 browser check — the VIP tab as an AM uses it (subpoints 4.4 + 4.5 + 4.6).
 *
 * ⚠️ RUN `live-w17.sh` FIRST: it builds the AM's portfolio through the product (self-assign) and
 * leaves the pair attached — this check reads that state, it does not create it.
 *
 * Two roles: the AM sees VIP on the rail, their portfolio on the page, and WRITES FIRST through the
 * form — the receipt is the ticket link, followed to the real ticket window. A line agent has no
 * VIP on the rail, and the typed URL answers in words.
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

async function signIn(email, password) {
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
  return { page, browser, errors };
}

// ── the AM: rail → portfolio → write first → the ticket ───────────────────────────────────────────
const STAMP = Date.now();
try {
  const { page, browser, errors } = await signIn('role-am@beton.win', ROLE_PW);
  try {
    await page.waitForSelector('nav a, aside a', { timeout: 20000 });
    if (await page.$('a[href="/vip"]')) pass('⭐ VIP is on the AM’s rail — the module follows the key');
    else fail('vip on the rail', 'no /vip link for the AM');

    await page.goto(`${WEB}/vip`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForSelector('[data-testid="portfolio-list"]', { timeout: 20000 });
    pass('the portfolio renders — the pair live-w17 attached is on the page');

    const writeBtn = await page.$('[data-testid^="write-first-"]');
    if (!writeBtn) {
      fail('a write-first control', 'none rendered');
    } else {
      const testid = await writeBtn.getAttribute('data-testid');
      const player = testid.replace('write-first-', '');
      await assertNoRenderStorm({ page, selector: `[data-testid="${testid}"]`, pass, fail });
      if (!(await page.$(`[data-testid="body-${player}"]`))) await page.click(`[data-testid="${testid}"]`);
      await page.fill(`[data-testid="subject-${player}"]`, `Browser first ${STAMP}`);
      await page.fill(`[data-testid="body-${player}"]`, `A first word from the browser (${STAMP}).`);
      await page.click(`[data-testid="send-first-${player}"]`);
      await page.waitForSelector(`[data-testid="initiated-${player}"]`, { timeout: 20000 });
      pass('⭐ wrote FIRST from the screen — the sent note carries the ticket link');

      await page.click(`[data-testid="initiated-${player}"] a`);
      await page.waitForURL((u) => String(u).includes('/tickets/'), { timeout: 20000 });
      // WAIT for the rendered text — the thread loads after navigation, and a one-shot read raced
      // it (two timeouts before reading the failure right). `innerText`, not textContent: the body's
      // textContent includes inline script sources, which is what the first failure dumped.
      await page.waitForFunction(
        (stamp) => document.body?.innerText?.includes(`(${stamp})`) ?? false,
        String(STAMP),
        { timeout: 20000 },
      );
      pass('…followed the link: the REAL ticket window shows the first message');
    }

    if (errors.length === 0) pass('no uncaught page errors during the AM pass');
    else fail('page errors (AM)', errors[0]);
  } finally {
    await browser.close().catch(() => {});
  }
} catch (err) {
  fail('the AM pass could not run', err instanceof Error ? err.message : String(err));
}

// ── the line agent: no module, in both senses ─────────────────────────────────────────────────────
try {
  const { page, browser, errors } = await signIn('role-support-agent@beton.win', ROLE_PW);
  try {
    await page.waitForSelector('nav a, aside a', { timeout: 20000 });
    if (!(await page.$('a[href="/vip"]'))) pass('⛔ a line agent’s rail has NO VIP entry — assembled from permissions');
    else fail('vip hidden from agent rail', 'the link is rendered');

    await page.goto(`${WEB}/vip`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForSelector('[data-testid="vip-not-available"]', { timeout: 20000 });
    const copy = (await page.textContent('[data-testid="vip-not-available"]')) ?? '';
    if (/granted, never enabled/.test(copy)) pass('⛔ …and the typed URL answers in WORDS: granted, never enabled (ADR 0034)');
    else fail('typed-url refusal copy', copy.slice(0, 80));

    if (errors.length === 0) pass('no uncaught page errors during the agent pass');
    else fail('page errors (agent)', errors[0]);
  } finally {
    await browser.close().catch(() => {});
  }
} catch (err) {
  fail('the agent pass could not run', err instanceof Error ? err.message : String(err));
}

console.log(`\nW17 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
