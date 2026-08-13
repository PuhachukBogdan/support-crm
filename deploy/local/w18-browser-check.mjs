/**
 * W18 browser check — personal settings and the theme that follows the person (5.2 + 5.3).
 *
 * The Done-when, as a person sees it: an AGENT (the rail fix's point) has Settings on their rail;
 * flipping the theme darkens the page NOW; a RELOAD keeps it; and — the block's real claim — a
 * FRESH BROWSER (new context, no localStorage) signing in as the same person gets the dark theme
 * FROM THE SERVER. Plus the standing anti-storm assertion on the flip.
 */
import { chromium } from 'playwright';
import { assertNoRenderStorm } from './lib/no-render-storm.mjs';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-beton.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.1:8025';
const ROLE_PW = process.env.ROLE_PASSWORD ?? 'Stand#Role7x';
const AGENT = 'role-support-agent@beton.win';

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

async function signIn(browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', AGENT);
  await page.fill('input[type="password"]', ROLE_PW);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  await page.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(AGENT));
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
  return { page, ctx, errors };
}

const isDark = (page) => page.evaluate(() => document.documentElement.classList.contains('dark'));

/** Poll the SERVER (with the page's own cookies) until it holds `mode` — a reload right after a
 *  flip would otherwise abort the PATCH in flight, and the fresh-browser claim would test a write
 *  that never landed (found by this check's own first run: 2× timeout). */
async function serverHolds(page, mode) {
  for (let i = 0; i < 15; i += 1) {
    const res = await page.request.get(`${WEB}/api/me/ui-preferences`).catch(() => null);
    const body = res ? await res.json().catch(() => null) : null;
    if (body?.values?.theme_mode === mode) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const browser = await chromium.launch();
try {
  // ── pass 1: the agent's own settings, the flip, the reload ──────────────────────────────────────
  const { page, ctx, errors } = await signIn(browser);
  await page.waitForSelector('nav a, aside a', { timeout: 20000 });
  if (await page.$('a[href="/settings"]')) pass('⭐ Settings is on a LINE AGENT’s rail — their own surface, no admin key (the W18 fix)');
  else fail('settings on the agent rail', 'no /settings link');

  await page.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForSelector('[data-testid="settings-ui"]', { timeout: 20000 });
  pass('the settings shell renders — Interface real, Accessibility/Profile reserved with owners');

  // Start from light so the flip means one thing on every run — and WAIT for the server to hold
  // it, or the dark PATCH below could land before this one and the order would be a coin flip.
  await page.click('[data-testid="theme-light"]');
  await page.waitForFunction(() => !document.documentElement.classList.contains('dark'), undefined, { timeout: 10000 });
  await serverHolds(page, 'light');

  // ⭐⭐ The standing anti-storm assertion on this page's key interaction.
  await assertNoRenderStorm({ page, selector: '[data-testid="theme-dark"]', pass, fail });
  await page.waitForFunction(() => document.documentElement.classList.contains('dark'), undefined, { timeout: 10000 });
  pass('the flip darkened the page NOW');

  // The write must LAND before the reload may run — a reload aborts an in-flight PATCH, and the
  // fresh-browser claim below would then test a write that never happened.
  if (await serverHolds(page, 'dark')) pass('…and the SERVER holds dark before we go anywhere');
  else fail('the dark write landed', 'server still answers light after 15s');

  await page.reload({ waitUntil: 'domcontentloaded' });
  if (await isDark(page)) pass('⭐ …and a RELOAD keeps it — applied before paint, no flash of light');
  else fail('theme after reload', 'came back light');

  if (errors.length === 0) pass('no uncaught page errors during the settings pass');
  else fail('page errors', errors[0]);
  await ctx.close();

  // ── pass 2: a FRESH browser — the server is the cross-machine truth ─────────────────────────────
  const fresh = await signIn(browser);
  await fresh.page.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 20000 });
  await fresh.page.waitForFunction(() => document.documentElement.classList.contains('dark'), undefined, { timeout: 15000 });
  pass('⭐⭐ a FRESH browser (no local storage) got the DARK theme from the SERVER — it follows the person');

  // Restore light through the same screen, and wait for the WRITE, not just the paint.
  await fresh.page.click('[data-testid="theme-light"]');
  await fresh.page.waitForFunction(() => !document.documentElement.classList.contains('dark'), undefined, { timeout: 10000 });
  if (await serverHolds(fresh.page, 'light')) pass('…and restored light for whoever comes next — confirmed on the server');
  else fail('the restore landed', 'server still answers dark after 15s');
  await fresh.ctx.close();
} catch (err) {
  fail('the pass could not run', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW18 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
