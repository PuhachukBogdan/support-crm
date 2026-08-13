/**
 * W13 browser check — the rail is assembled from PERMISSIONS, and a reserved slot says so
 * (subpoints 3.7 + 3.13; roadmap 9.14).
 *
 * ⭐ The claim only two browsers side by side can make: **a line agent and a supervisor see
 * DIFFERENT rails**, and the difference is the server's permission set rather than a client-side
 * "simplified mode" somebody could switch off. So this check signs in TWICE, with two real roles,
 * and diffs what each rail offers.
 *
 * Also here: a hidden module is unreachable by URL (not merely unlinked), a coming-soon module says
 * it is reserved rather than broken, and the standing anti-storm assertion on the rail's own key
 * interaction — navigating between modules.
 */
import { chromium } from 'playwright';
import { assertNoRenderStorm } from './lib/no-render-storm.mjs';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-beton.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.1:8025';
const ROLE_PW = process.env.ROLE_PASSWORD ?? 'Stand#Role7x';

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

/** Sign in and return the rail's entries (label + href) for that role. */
async function railOf(email) {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
    const page = await ctx.newPage();
    await page.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', ROLE_PW);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(2500);
    await page.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(email));
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
    await page.waitForSelector('nav a, aside a', { timeout: 20000 });
    const entries = await page.$$eval('a[href^="/"]', (as) =>
      as
        .map((a) => `${(a.textContent ?? '').trim()}|${a.getAttribute('href')}`)
        .filter((s) => s.split('|')[0].length > 0),
    );
    const state = await ctx.storageState();
    return { entries: [...new Set(entries)], state };
  } finally {
    await browser.close().catch(() => {});
  }
}

let supervisor;
try {
  const agent = await railOf('role-support-agent@beton.win');
  supervisor = await railOf('role-teamlead@beton.win');
  pass('both roles signed in and rendered a rail');

  const hrefs = (r) => new Set(r.entries.map((e) => e.split('|')[1]));
  const agentHrefs = hrefs(agent);
  const supHrefs = hrefs(supervisor);
  note(`  agent rail:      ${[...agentHrefs].sort().join(' ')}`);
  note(`  supervisor rail: ${[...supHrefs].sort().join(' ')}`);

  // ⭐ The claim: the rails DIFFER, and the agent's is the narrower one.
  const extra = [...agentHrefs].filter((h) => !supHrefs.has(h));
  const missing = [...supHrefs].filter((h) => !agentHrefs.has(h));
  if (missing.length > 0) pass(`⭐ the supervisor's rail carries more: ${missing.join(' ')}`);
  else fail('rails differ by role', 'both rails offer the same entries — the permission gate is doing nothing');
  if (extra.length === 0) pass('…and the agent rail is a strict SUBSET — nothing appears only for them');
  else fail('agent rail subset', `agent-only: ${extra.join(' ')}`);

  // ⛔ A HIDDEN module is unreachable, not merely unlinked (R13's slot must not answer).
  if (!agentHrefs.has('/telephony') && !supHrefs.has('/telephony')) pass('⛔ the hidden module is on nobody\'s rail');
  else fail('hidden module linked', 'telephony appears in a rail');
} catch (err) {
  fail('the two-role pass could not run', err instanceof Error ? err.message : String(err));
}

// ── the reserved slots, seen by a role that has them ──────────────────────────────────────────────
if (supervisor?.state) {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, storageState: supervisor.state, viewport: { width: 1920, height: 1080 }, ...creds });
    const p = await ctx.newPage();
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));

    await p.goto(WEB, { waitUntil: 'networkidle', timeout: 30000 });
    await p.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });

    // ⭐⭐ The standing anti-storm assertion on the rail's own key interaction.
    const escalations = await p.$('a[href="/escalations"]');
    if (escalations) {
      pass('the Escalations slot is on the rail (W13 / 3.13)');
      await assertNoRenderStorm({ page: p, selector: 'a[href="/escalations"]', pass, fail });
      const copy = (await p.textContent('[data-testid="module-coming-soon"]').catch(() => '')) ?? '';
      if (/reserved and not built yet/.test(copy) && /nothing is missing/.test(copy))
        pass('…and it reads as RESERVED, not broken and not a permission problem');
      else fail('reserved copy', copy.slice(0, 80));
    } else {
      fail('escalations slot', 'not on the supervisor rail');
    }

    // The admin centre lists what it will hold, and offers no dead controls.
    await p.goto(`${WEB}/admin`, { waitUntil: 'networkidle', timeout: 20000 });
    const sections = await p.$$eval('[data-testid^="admin-section-"]', (els) => els.length);
    if (sections >= 5) pass(`the Admin Center lists its reserved sections (${sections}), each owned by a point`);
    else fail('admin sections', `only ${sections}`);
    const clickable = await p.$$eval('[data-testid="admin-center"] a, [data-testid="admin-center"] button', (els) => els.length);
    if (clickable === 0) pass('⛔ nothing on it is clickable — a reserved slot is not a dead control');
    else fail('dead controls', `${clickable} focusable elements`);

    // ⛔ The hidden module answers nothing, even typed by hand.
    const res = await p.goto(`${WEB}/telephony`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const body = (await p.textContent('body').catch(() => '')) ?? '';
    if ((res && res.status() === 404) || /not found|404/i.test(body))
      pass('⛔ the hidden module is unreachable by URL, not merely unlinked');
    else fail('hidden module reachable', `status ${res?.status()} body ${body.slice(0, 60)}`);

    if (errors.length === 0) pass('no uncaught page errors during the whole pass');
    else fail('page errors', errors[0]);
  } catch (err) {
    fail('the slots pass could not run', err instanceof Error ? err.message : String(err));
  } finally {
    await browser.close().catch(() => {});
  }
}

console.log(`\nW13 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
