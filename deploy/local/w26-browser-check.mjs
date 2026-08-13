/**
 * W26 browser check — the slide-out panels (R42), as BEHAVIOUR.
 *
 *   1  the panel rests CLOSED: three icons, no drawer — the left rail's own philosophy
 *   2  ⭐ the anti-storm STANDING RULE on the block's key interaction (opening a panel)
 *   3  the active list is SERVER state: two tickets manufactured and opened are both on it
 *   4  ⭐ toggling panels fires NO reload of the window beneath (no detail/thread refetch)
 *   5  the same click takes the panel back — «нажимаешь — выезжает, повторно — убирается»
 *   6  ⭐ the open panel SURVIVES navigating ticket→ticket through its own list
 *   + light and dark screenshots of the open panel through the product's theme control
 *
 * ⚠️ Every panel selector is SCOPED inside [data-testid="ticket-context-panel"]: the LEFT rail also
 * mints `rail-<key>` testids (`rail-knowledge`, `rail-settings`…), and the presence check paid for
 * an unscoped selector the same week (vacuous-pass instance 9). No collision exists today; the
 * scoping is so a rename never creates one silently.
 *
 * Run ON THE STAND against the VERIFICATION origin (rule 12 — the public link is frozen).
 */
import { chromium } from 'playwright';
import { assertNoRenderStorm } from './lib/no-render-storm.mjs';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-next.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.2:8025';
const AGENT = process.env.PROBE_EMAIL ?? 'role-support-agent@beton.win';
const AGENT_PW = process.env.PROBE_PASSWORD ?? 'Stand#Role7x';
const ADMIN = process.env.ADMIN_EMAIL ?? 'admin@example.test';
const ADMIN_PW = process.env.ADMIN_PASSWORD ?? '';
const PLAYER = process.env.PLAYER_ID ?? 'seed-player-001';
const BRAND = process.env.BRAND_ID ?? 'seed-brand-0000-0000-000000000001';
const SHOTS = process.env.SHOT_DIR ?? '/tmp/pw-work/shots';

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
  throw new Error(`no login code for ${email}`);
}

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

async function manufactureArrival(adminApi, agentOperatorId, n) {
  const created = await adminApi('POST', '/conversations/initiate-email', {
    brandId: BRAND,
    playerId: PLAYER,
    subject: `w26 panel ${n} ${Date.now().toString(36)}`,
    body: 'slide-out panel check',
  });
  const id = created.json?.id;
  if (!id) throw new Error(`initiate-email failed: ${created.status} ${JSON.stringify(created.json).slice(0, 120)}`);
  const assigned = await adminApi('PUT', `/conversations/${id}/assignee`, { operatorId: agentOperatorId });
  if (assigned.status !== 200) throw new Error(`assign failed: ${assigned.status}`);
  return { id, subject: created.json?.subject ?? `w26 panel ${n}` };
}

/** Scoped: the LEFT rail mints rail-* testids too (see the header note). */
const inPanel = (testid) => `[data-testid="ticket-context-panel"] [data-testid="${testid}"]`;

const browser = await chromium.launch();
try {
  const creds = process.env.EDGE_USER
    ? { httpCredentials: { username: process.env.EDGE_USER, password: process.env.EDGE_PASSWORD ?? '' } }
    : {};
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));

  // ── sign in; manufacture two tickets in the agent's slice, through the product ─────────────────
  await p.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.fill('input[type="email"]', AGENT);
  await p.fill('input[type="password"]', AGENT_PW);
  await p.click('button[type="submit"]');
  await p.waitForTimeout(2500);
  await p.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(AGENT));
  await p.click('button[type="submit"]');
  await p.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
  pass('the agent signed in');

  const api = await apiSession(ADMIN, ADMIN_PW);
  const users = await api('GET', '/admin/access/users');
  const agentUser = (users.json?.users ?? []).find((u) => u.email === AGENT);
  const ops = await api('GET', `/operators?authUserIds=${agentUser?.userId ?? agentUser?.id}`);
  const agentOperatorId = ops.json?.operators?.[0]?.operatorId;
  if (!agentOperatorId) throw new Error('could not resolve the agent operator id');
  const t1 = await manufactureArrival(api, agentOperatorId, 1);
  const t2 = await manufactureArrival(api, agentOperatorId, 2);
  pass('two tickets manufactured and assigned through the product');

  // Opening each window writes the read-mark — the "opened by me" leg of the rail's server view.
  await p.goto(`${WEB}/tickets/${t1.id}`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="ticket-window"]', { timeout: 20000 });
  await p.goto(`${WEB}/tickets/${t2.id}`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="ticket-window"]', { timeout: 20000 });

  // ── 1: rests closed — icons only ────────────────────────────────────────────────────────────────
  // ⚠️ state:'attached' — the CLOSED drawer is w-0, and Playwright's default wait is VISIBLE:
  // waiting for visibility here times out precisely because the resting shape is correct.
  await p.waitForSelector(inPanel('context-drawer'), { state: 'attached', timeout: 10000 });
  const restState = await p.getAttribute(inPanel('context-drawer'), 'data-state');
  const railCount = await p.$$eval(
    '[data-testid="ticket-context-panel"] nav button',
    (els) => els.length,
  );
  if (restState === 'closed' && railCount === 3)
    pass('⭐ the panel rests CLOSED: three icons, no drawer — the rail alone');
  else fail('resting shape', `state=${restState}, buttons=${railCount}`);

  // ── 2+4: the storm rule on the key interaction, with the refetch ledger running ────────────────
  const reloads = [];
  p.on('request', (r) => {
    const u = r.url();
    // The window beneath = THIS ticket's detail and thread. The active list's own read is the
    // panel's legitimate content, not a reload of what lies under it.
    if (u.includes(`/api/conversations/${t2.id}`)) reloads.push(u);
  });
  await p.waitForSelector(inPanel('rail-active'), { timeout: 5000 }); // the target EXISTS (lesson #8)
  await assertNoRenderStorm({ page: p, selector: inPanel('rail-active'), pass, fail });
  const drawerOpen = await p.getAttribute(inPanel('context-drawer'), 'data-state');
  if (drawerOpen === 'open') pass('…and that click OPENED the drawer (the storm claim measured a real interaction)');
  else fail('drawer after click', drawerOpen);

  // ── 3: the list is server state — both opened tickets are on it ─────────────────────────────────
  await p.waitForSelector(inPanel('active-tickets'), { timeout: 10000 });
  const listText = (await p.textContent(inPanel('active-tickets'))) ?? '';
  if (listText.includes(t1.subject) && listText.includes(t2.subject))
    pass('⭐ the active list carries BOTH tickets — assembled from server state, not browser tabs');
  else fail('active list content', listText.slice(0, 120));

  // ── screenshots of the open panel, both themes, through the product control ────────────────────
  await p.screenshot({ path: `${SHOTS}/w26-panel-light.png` });
  await p.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.click('[data-testid="theme-dark"]');
  await p.waitForFunction(() => document.documentElement.classList.contains('dark'), undefined, { timeout: 8000 });
  await p.goto(`${WEB}/tickets/${t2.id}`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector(inPanel('context-drawer'), { state: 'attached', timeout: 20000 });
  // A FULL load resets the choice (client state, like the left rail) — reopen for a comparable frame.
  await p.$eval(inPanel('rail-active'), (el) => el.click());
  await p.waitForSelector(inPanel('active-tickets'), { timeout: 10000 });
  // ⚠️ The list is VISIBLE the moment the drawer starts moving — the first dark frame was shot
  // mid-slide, rows clipped to their right halves (a-screenshot-is-one-frame). Outwait --motion-base.
  await p.waitForTimeout(600);
  const darkStillOpen = await p.getAttribute(inPanel('context-drawer'), 'data-state');
  await p.screenshot({ path: `${SHOTS}/w26-panel-dark.png` });
  await p.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.click('[data-testid="theme-light"]');
  await p.waitForTimeout(1000);
  pass(`both-theme screenshots taken through the product control (drawer after theme trip: ${darkStillOpen})`);

  // ── 4 continued + 5 + 6, back on the ticket ─────────────────────────────────────────────────────
  await p.goto(`${WEB}/tickets/${t2.id}`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector(inPanel('context-drawer'), { state: 'attached', timeout: 20000 });
  reloads.length = 0; // count only what the TOGGLES cause from here

  await p.$eval(inPanel('rail-player'), (el) => el.click());
  await p.waitForTimeout(800);
  await p.$eval(inPanel('rail-kb'), (el) => el.click());
  await p.waitForTimeout(800);
  await p.$eval(inPanel('rail-kb'), (el) => el.click()); // same icon → closes
  await p.waitForTimeout(800);
  const closedAgain = await p.getAttribute(inPanel('context-drawer'), 'data-state');
  if (closedAgain === 'closed') pass('⭐ the SAME icon takes its panel back — «повторно — убирается»');
  else fail('toggle close', closedAgain);
  if (reloads.length === 0)
    pass('⭐ three toggles, ZERO refetches of the window beneath — the list under the panel was not reloaded');
  else fail('window beneath reloaded', `${reloads.length}: ${reloads[0]}`);

  // ── 6: the open panel survives ticket→ticket through its own list ──────────────────────────────
  await p.$eval(inPanel('rail-active'), (el) => el.click());
  await p.waitForSelector(inPanel('active-tickets'), { timeout: 10000 });
  await p.click(`${inPanel('active-tickets')} >> text=${t1.subject}`);
  await p.waitForURL((u) => String(u).includes(t1.id), { timeout: 20000 });
  await p.waitForSelector('[data-testid="ticket-window"]', { timeout: 20000 });
  await p.waitForTimeout(1000);
  const survivedState = await p.getAttribute(inPanel('context-drawer'), 'data-state');
  const survivedExpanded = await p.getAttribute(inPanel('rail-active'), 'aria-expanded');
  if (survivedState === 'open' && survivedExpanded === 'true')
    pass('⭐ the open panel SURVIVES ticket→ticket navigation — «переживает переход между тикетами»');
  else fail('panel across navigation', `state=${survivedState}, expanded=${survivedExpanded}`);

  if (errors.length === 0) pass('no uncaught page errors during the whole pass');
  else fail('page errors', errors.slice(0, 2).join(' | '));
} catch (err) {
  fail('the pass could not run', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW26 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
