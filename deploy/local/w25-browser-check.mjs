/**
 * W25 browser check — the unread badge's four rules, as BEHAVIOUR (R23 / 9.12).
 *
 * Two parties: the AGENT's real browser (where the badge lives), and an API session (admin) that
 * manufactures ARRIVALS through the product's own paths — initiate-email creates a NEW conversation,
 * assignment puts it in the agent's slice. Realtime is on for this stand, so the badge reacts to the
 * event; the 60s poll is the deployment fallback, not what this file waits for.
 *
 *   rule 1  Inbox closed + ticket arrives → the badge appears/увеличивается (red, on the module icon)
 *   rule 3  opening the Inbox resets — badge gone, and STAYS gone after navigating away
 *   rule 2  Inbox OPEN + ticket arrives → after navigating away the badge still shows nothing
 *   rule 4  the display caps at 99+ — jsdom's claim (a fixture of 120 is not manufacturable here
 *           through honest paths); the live half is that the badge shows the NUMBER, not noise
 *   + the row dot: the arrival wears the red dot on its row when the Inbox is next opened
 *
 * ⓘ The SOUND is deliberately not asserted here: headless Chromium's autoplay policy keeps the
 * AudioContext suspended, so "no sound" is the policy working, not the feature failing. Its claims
 * live in jsdom (the chime is asked for on growth-while-away) and in the server's own property (the
 * count is the caller's slice — «только на свои» by construction).
 *
 * Run ON THE STAND against the VERIFICATION origin (rule 12 — the public link is frozen).
 */
import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-next.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.2:8025';
const AGENT = process.env.PROBE_EMAIL ?? 'role-support-agent@beton.win';
const AGENT_PW = process.env.PROBE_PASSWORD ?? 'Stand#Role7x';
const ADMIN = process.env.ADMIN_EMAIL ?? 'admin@example.test';
const ADMIN_PW = process.env.ADMIN_PASSWORD ?? '';
const PLAYER = process.env.PLAYER_ID ?? 'seed-player-001';
const BRAND = process.env.BRAND_ID ?? 'seed-brand-0000-0000-000000000001';

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
  throw new Error(`no login code for ${email}`);
}

/** An API session over the TLS edge (Node fetch keeps no cookies; Secure survives — https origin). */
async function apiSession(email, password) {
  const base = `${WEB}/api`;
  const h = { 'Content-Type': 'application/json', ...edgeHeaders() };
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: h, body: JSON.stringify({ email, password }) });
  const { challengeId } = await login.json();
  if (!challengeId) throw new Error(`login step 1 failed for ${email}`);
  await new Promise((r) => setTimeout(r, 3000));
  const code = await codeFor(email);
  const verify = await fetch(`${base}/auth/verify`, { method: 'POST', headers: h, body: JSON.stringify({ challengeId, code }) });
  const setCookie = verify.headers.getSetCookie?.() ?? [];
  const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`verify produced no cookie for ${email}`);
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...h, Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json };
  };
}

/** One ARRIVAL in the agent's slice, through the product: initiate-email + assign, both as the
 *  ADMIN — the template holds every key except the two super-admin exclusives (catalogue.ts:233),
 *  and feature 030's portfolio narrowing binds only am/shift_am, so an admin may write first to any
 *  player with a known address. */
async function manufactureArrival(adminApi, agentOperatorId, n) {
  const created = await adminApi('POST', '/conversations/initiate-email', {
    brandId: BRAND,
    playerId: PLAYER,
    subject: `w25 arrival ${n} ${Date.now().toString(36)}`,
    body: 'unread badge check',
  });
  const id = created.json?.id;
  if (!id) throw new Error(`initiate-email failed: ${created.status} ${JSON.stringify(created.json).slice(0, 120)}`);
  const assigned = await adminApi('PUT', `/conversations/${id}/assignee`, { operatorId: agentOperatorId });
  if (assigned.status !== 200) throw new Error(`assign failed: ${assigned.status}`);
  // The badge counts the Inbox bucket (new+open); initiate-email creates in `open` — already in.
  return id;
}

const browser = await chromium.launch();
try {
  const creds = process.env.EDGE_USER
    ? { httpCredentials: { username: process.env.EDGE_USER, password: process.env.EDGE_PASSWORD ?? '' } }
    : {};
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));

  // ── the agent signs in ──────────────────────────────────────────────────────────────────────────
  await p.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.fill('input[type="email"]', AGENT);
  await p.fill('input[type="password"]', AGENT_PW);
  await p.click('button[type="submit"]');
  await p.waitForTimeout(2500);
  await p.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(AGENT));
  await p.click('button[type="submit"]');
  await p.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
  await p.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });
  pass('the agent signed in (lands on the Inbox — the mark is fresh)');

  // ── the admin API session, and the agent's operator id ─────────────────────────────────────────
  const api = await apiSession(ADMIN, ADMIN_PW);
  const users = await api('GET', '/admin/access/users');
  const agentUser = (users.json?.users ?? []).find((u) => u.email === AGENT);
  const ops = await api('GET', `/operators?authUserIds=${agentUser?.userId ?? agentUser?.id}`);
  const agentOperatorId = ops.json?.operators?.[0]?.operatorId;
  if (!agentOperatorId) throw new Error('could not resolve the agent operator id');
  pass('admin API session up; the agent’s operator id resolved through the product');

  // ── rule 3 first (baseline): on the Inbox the badge shows NOTHING ───────────────────────────────
  if (!(await p.$('[data-testid="inbox-unread-badge"]')))
    pass('on the Inbox itself the badge shows NOTHING — while you look at the list, nothing is unseen');
  else fail('badge suppressed on Inbox', 'a number renders while the list is open');

  // ── rule 1: Inbox CLOSED + a ticket arrives → the badge appears, red, with the number ──────────
  await p.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await manufactureArrival(api, agentOperatorId, 1);
  await p.waitForSelector('[data-testid="inbox-unread-badge"]', { timeout: 70000 });
  const badge1 = (await p.textContent('[data-testid="inbox-unread-badge"]'))?.trim();
  if (badge1 === '1') pass(`⭐ rule 1: an arrival while elsewhere → the badge shows ${badge1}`);
  else fail('rule 1 badge count', badge1);
  const isRed = await p.$eval('[data-testid="inbox-unread-badge"]', (el) => el.className.includes('bg-destructive'));
  if (isRed) pass('…and it is the red — the colour R38 freed for exactly this');
  else fail('badge colour', 'not the destructive token');

  // a second arrival moves it to 2 — the derived count, not a boolean
  await manufactureArrival(api, agentOperatorId, 2);
  await p.waitForFunction(
    () => document.querySelector('[data-testid="inbox-unread-badge"]')?.textContent?.trim() === '2',
    undefined,
    { timeout: 70000 },
  );
  pass('⭐ a second arrival → 2. A NUMBER, not a flag');

  // ── the row dots + rule 3: opening the Inbox shows the arrivals dotted, and resets ─────────────
  await p.goto(`${WEB}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });
  await p.waitForTimeout(1500);
  const dots = await p.$$eval('[data-testid="row-unseen"]', (els) => els.length);
  if (dots === 2) pass('⭐ the ROW dots mark exactly the two arrivals — one fact, two surfaces');
  else fail('row dots', `${dots} (wanted 2)`);

  await p.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(2500);
  if (!(await p.$('[data-testid="inbox-unread-badge"]')))
    pass('⭐ rule 3: opening the Inbox RESET the counter — the badge stays gone after leaving');
  else fail('rule 3 reset', `badge still shows ${await p.textContent('[data-testid="inbox-unread-badge"]')}`);

  // ── rule 2: Inbox OPEN + a ticket arrives → no unseen accumulates ───────────────────────────────
  await p.goto(`${WEB}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });
  await manufactureArrival(api, agentOperatorId, 3);
  // Give the event time to reach the OPEN page (its re-mark is what rule 2 rides on).
  await p.waitForTimeout(5000);
  await p.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForTimeout(2500);
  if (!(await p.$('[data-testid="inbox-unread-badge"]')))
    pass('⭐ rule 2: an arrival while the Inbox was OPEN counts as seen — no badge after leaving');
  else fail('rule 2', `badge shows ${await p.textContent('[data-testid="inbox-unread-badge"]')}`);

  note('rule 4 (99+) is jsdom’s: 120 unseen arrivals are not manufacturable honestly here');
  note('the sound is not asserted: headless autoplay policy keeps the AudioContext suspended by design');

  if (errors.length === 0) pass('no uncaught page errors during the whole pass');
  else fail('page errors', errors.slice(0, 2).join(' | '));
} catch (err) {
  fail('the pass could not run', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW25 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
