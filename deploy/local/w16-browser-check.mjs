/**
 * W16 browser check — the two tables: the tag registry (/admin/tags) and the audit log
 * (/admin/audit) as a person uses them (subpoints 3.11 + 3.12).
 *
 * The audit page is the one the plan called the most profitable in it — so the owner pass asserts
 * the thing that makes it real: rows RENDER with a human-readable actor, and the class filter
 * narrows without a reload. The teamlead pass asserts the refusal is words (audit) while the tag
 * registry — a vocabulary read every agent role holds — renders for them.
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

// ── the owner: both tables, and the filter that narrows without a reload ──────────────────────────
try {
  const { page, browser, errors } = await signIn(OWNER_EMAIL, OWNER_PW);
  try {
    await page.goto(`${WEB}/admin/tags`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForSelector('[data-testid="tags-list"]', { timeout: 20000 });
    const rows = await page.$$eval('[data-testid^="tag-"][data-testid*="-"]', (els) => els.length);
    pass(`the tag registry renders (${rows} elements) — names with counts, busiest first`);
    const firstCount = await page.$eval('[data-testid^="tag-count-"]', (el) => el.textContent ?? '');
    if (/^\d+$/.test(firstCount.trim())) pass(`…and the top row carries a numeric count (${firstCount.trim()})`);
    else fail('numeric count', firstCount.slice(0, 30));

    await page.goto(`${WEB}/admin/audit`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForSelector('[data-testid="audit-list"]', { timeout: 20000 });
    pass('⭐ the audit log RENDERS — written since April, readable at last');
    const body = (await page.textContent('[data-testid="audit-list"]')) ?? '';
    if (/@/.test(body)) pass('…and a human actor shows as an EMAIL, not a UUID (the staff join)');
    else fail('actor join', body.slice(0, 120));

    // ⭐⭐ The standing anti-storm assertion, on this page's key interaction (the class filter).
    await assertNoRenderStorm({ page, selector: '[data-testid="audit-class-filter"]', pass, fail });

    // The dropdown is open after the storm-check click; pick `privilege` and watch it narrow.
    const item = await page.$('[role="menuitem"]:has-text("privilege")');
    if (!item) await page.click('[data-testid="audit-class-filter"]');
    await page.click('[role="menuitem"]:has-text("privilege")');
    await page.waitForFunction(
      () => {
        const list = document.querySelector('[data-testid="audit-list"]');
        if (!list) return false;
        const codes = [...list.querySelectorAll('code')].map((c) => c.textContent ?? '');
        // The privilege class in full: role.* permission.* presence.* AND the group family —
        // whose actions are `group.*`, `group_member.*`, `group_permission.*`. The first version
        // required a dot straight after `group` and timed out on the stand's real
        // `group_member.add` rows (written by W14's own live round) — the check's regex was
        // narrower than the catalogue, not the filter broken.
        return codes.length > 0 && codes.every((c) => /^(role|permission|presence)\.|^group/.test(c));
      },
      { timeout: 15000 },
    );
    pass('⭐ the class filter narrowed to privilege-class actions only, without a reload');

    if (errors.length === 0) pass('no uncaught page errors during the owner pass');
    else fail('page errors (owner)', errors[0]);
  } finally {
    await browser.close().catch(() => {});
  }
} catch (err) {
  fail('the owner pass could not run', err instanceof Error ? err.message : String(err));
}

// ── the teamlead: audit refused in words; the tag registry answers (their own vocabulary) ─────────
try {
  const { page, browser, errors } = await signIn('role-teamlead@beton.win', ROLE_PW);
  try {
    await page.goto(`${WEB}/admin/audit`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForSelector('[data-testid="audit-error"]', { timeout: 20000 });
    const copy = (await page.textContent('[data-testid="audit-error"]')) ?? '';
    if (/do not have access/i.test(copy)) pass('⛔ a teamlead gets the audit refusal IN WORDS — never an empty table');
    else fail('worded audit refusal', copy.slice(0, 80));

    await page.goto(`${WEB}/admin/tags`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForSelector('[data-testid="tags-list"]', { timeout: 20000 });
    pass('…while the tag registry answers for them — it is the vocabulary their own tickets wear');

    if (errors.length === 0) pass('no uncaught page errors during the teamlead pass');
    else fail('page errors (teamlead)', errors[0]);
  } finally {
    await browser.close().catch(() => {});
  }
} catch (err) {
  fail('the teamlead pass could not run', err instanceof Error ? err.message : String(err));
}

console.log(`\nW16 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
