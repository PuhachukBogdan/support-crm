/**
 * W14 browser check — the People & groups page, with the block's remainder: INVITING FROM THE SCREEN
 * (subpoint 3.8; the 010 engine has existed since Phase 3, this checks the button a human presses).
 *
 * Two roles, because the page carries two authorization models and the check must see both:
 *   · the OWNER (super_admin) — sees the list, the role controls, and the Invite button; sends a
 *     real invitation and watches the invited person appear in the list;
 *   · a TEAMLEAD — sees the list (users.list.view) and gets NO invite entry point at all: the
 *     capability is absent, not disabled (the same by-absence rule W13 proved for the rail).
 *
 * Plus the standing anti-storm assertion on the page's key interaction (opening the invite form).
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

/** Sign in and land on /admin/people; returns {page, ctx, browser, errors}. */
async function openPeopleAs(email, password) {
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
  await page.goto(`${WEB}/admin/people`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForSelector('[data-testid="people-list"]', { timeout: 20000 });
  return { page, ctx, browser, errors };
}

// ── the owner: the invite path, end to end, through the DOM ───────────────────────────────────────
// A fresh address per run: with a fixed one, run 2's "the row appears" would be satisfied by run 1's
// leftovers — a vacuous pass, the exact shape rule 3 exists for.
const INVITEE = `w14-ui-${Date.now()}@beton.win`;
try {
  const { page, browser, errors } = await openPeopleAs(OWNER_EMAIL, OWNER_PW);
  try {
    pass('the owner signed in and the people list rendered');

    if (await page.$('[data-testid="invite-open"]')) pass('the Invite button is offered to a super-admin');
    else fail('invite button for the owner', 'not present');

    // ⭐⭐ The standing anti-storm assertion, on this page's key interaction.
    await assertNoRenderStorm({ page, selector: '[data-testid="invite-open"]', pass, fail });

    // The toggle click above OPENED the form; if not, open it now.
    if (!(await page.$('[data-testid="invite-form"]'))) await page.click('[data-testid="invite-open"]');
    await page.waitForSelector('[data-testid="invite-email"]', { timeout: 5000 });
    await page.fill('[data-testid="invite-email"]', INVITEE);
    await page.click('[data-testid="invite-send"]');
    await page.waitForSelector('[data-testid="invite-sent"]', { timeout: 15000 });
    pass(`⭐ the invitation was sent from the screen (${INVITEE})`);

    // The receipt a human sees: the invited person appears in the list, marked invited.
    await page.waitForFunction(
      (email) => document.querySelector('[data-testid="people-list"]')?.textContent?.includes(email),
      INVITEE,
      { timeout: 15000 },
    );
    const row = await page.evaluate((email) => {
      const li = [...document.querySelectorAll('[data-testid="people-list"] li')].find((el) => el.textContent?.includes(email));
      return li?.textContent ?? '';
    }, INVITEE);
    if (/invited/.test(row)) pass('…and they appear in the list as INVITED — the list is the receipt');
    else fail('invited row', `row text: ${row.slice(0, 100)}`);

    if (errors.length === 0) pass('no uncaught page errors during the owner pass');
    else fail('page errors (owner)', errors[0]);
  } finally {
    await browser.close().catch(() => {});
  }
} catch (err) {
  fail('the owner pass could not run', err instanceof Error ? err.message : String(err));
}

// ── the teamlead: the same page, and the capability is ABSENT ─────────────────────────────────────
try {
  const { page, browser, errors } = await openPeopleAs('role-teamlead@beton.win', ROLE_PW);
  try {
    pass('a teamlead signed in and sees the people list (users.list.view)');
    if (!(await page.$('[data-testid="invite-open"]'))) pass('⛔ …and has NO invite entry point — absent, not disabled');
    else fail('invite hidden from teamlead', 'the button is rendered');
    const roleButtons = await page.$$eval('[data-testid^="set-role-"]', (els) => els.length);
    if (roleButtons === 0) pass('⛔ …and no role controls either (ownership act, not a supervisory one)');
    else fail('role controls hidden from teamlead', `${roleButtons} rendered`);
    if (errors.length === 0) pass('no uncaught page errors during the teamlead pass');
    else fail('page errors (teamlead)', errors[0]);
  } finally {
    await browser.close().catch(() => {});
  }
} catch (err) {
  fail('the teamlead pass could not run', err instanceof Error ? err.message : String(err));
}

console.log(`\nW14 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
