/**
 * W22-доп browser check — the administrator's presets in the status menu, as BEHAVIOUR (ADR 0042 §7).
 *
 * The model under test is the one the 2026-08-10 revert taught: a `PresenceLabel` is a preset WITH A
 * REASON, several per state («Break»+«Lunch» are both `away` on the seed), so the menu must offer
 * EVERY row below the four states — never use one as a state's name. Choosing one writes the pair
 * `{state, labelId}`; the router reads the state, the label rides as the recorded why.
 *
 *   1  the menu mirrors the TABLE — every label the wire lists is a row, in the wire's order
 *   2  cardinality survives — a same-state pair renders as TWO rows (the revert's exact defect)
 *   3  choosing a preset → the dot wears its state, and the fact SURVIVES A RELOAD (server fact)
 *   4  …and the server says so too: GET /presence shows the state AND the labelId
 *   5  a bare state afterwards CLEARS the label — reload agrees, the wire agrees
 *   6  a STALE preset (admin deleted it mid-menu) is refused — the badge goes back, nothing lies
 *   + light and dark screenshots THROUGH THE PRODUCT's theme control, restored afterwards
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
const SHOTS = process.env.SHOT_DIR ?? '/tmp/pw-work/shots';

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

const openMenu = async (p) => {
  await p.click('[data-testid="user-menu-trigger"]');
  await p.waitForSelector('[data-testid="user-menu"]', { timeout: 8000 });
};
/**
 * ⚠️ EVERY state-row selector is SCOPED to the open menu, and the scoping is load-bearing: /settings
 * carries its own two-state presence control with the SAME testids (`presence-online` / `presence-away`,
 * profile-section.tsx). An unscoped selector resolves to the page's control — which sits under the
 * modal menu's pointer-events:none body, so a click times out with «html intercepts pointer events»
 * and an attribute read reads the wrong element and passes vacuously. Both happened on the first run.
 */
const inMenu = (testid) => `[data-testid="user-menu"] [data-testid="${testid}"]`;
const presetRows = (p) =>
  p.$$eval('[data-testid^="status-preset-"]', (els) =>
    els.map((el) => ({
      id: el.getAttribute('data-testid').replace('status-preset-', ''),
      text: el.textContent?.trim() ?? '',
      current: el.getAttribute('aria-current') === 'true',
    })),
  );

const browser = await chromium.launch();
try {
  const creds = process.env.EDGE_USER
    ? { httpCredentials: { username: process.env.EDGE_USER, password: process.env.EDGE_PASSWORD ?? '' } }
    : {};
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));

  // ── the agent signs in; the admin API session mirrors the table ────────────────────────────────
  await p.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.fill('input[type="email"]', AGENT);
  await p.fill('input[type="password"]', AGENT_PW);
  await p.click('button[type="submit"]');
  await p.waitForTimeout(2500);
  await p.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(AGENT));
  await p.click('button[type="submit"]');
  await p.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
  await p.waitForSelector('[data-testid="user-menu-trigger"]', { timeout: 20000 });
  pass('the agent signed in');

  const api = await apiSession(ADMIN, ADMIN_PW);
  const wire = await api('GET', '/presence/labels');
  const labels = wire.json?.labels ?? [];
  if (labels.length > 0) pass(`the wire lists ${labels.length} presets — the table this menu must mirror`);
  else fail('presets on the wire', `GET /presence/labels → ${wire.status}, ${labels.length} rows`);

  const users = await api('GET', '/admin/access/users');
  const agentUser = (users.json?.users ?? []).find((u) => u.email === AGENT);
  const ops = await api('GET', `/operators?authUserIds=${agentUser?.userId ?? agentUser?.id}`);
  const agentOperatorId = ops.json?.operators?.[0]?.operatorId;
  const agentAuthId = agentUser?.userId ?? agentUser?.id;
  if (!agentOperatorId) throw new Error('could not resolve the agent operator id');
  const presenceOf = async () => (await api('GET', `/presence?operatorIds=${agentAuthId}`)).json?.presence?.[0];

  // ── 1+2: the menu mirrors the table, EVERY row, below the states ───────────────────────────────
  await openMenu(p);
  const states = await p.$$eval('[data-testid="user-menu"] [data-testid^="presence-"]', (els) => els.length);
  if (states === 4) pass('the four base states are all offered');
  else fail('base states', `${states} (wanted 4)`);

  const rows = await presetRows(p);
  if (rows.length === labels.length && labels.every((l, i) => rows[i]?.id === l.id && rows[i]?.text.includes(l.name)))
    pass(`⭐ the menu mirrors the table: ${rows.length} preset rows, the wire's order, the admin's words`);
  else fail('menu mirrors table', `menu ${JSON.stringify(rows.map((r) => r.id))} vs wire ${JSON.stringify(labels.map((l) => l.id))}`);

  const byState = new Map();
  for (const l of labels) byState.set(l.state, (byState.get(l.state) ?? 0) + 1);
  const paired = [...byState.entries()].find(([, n]) => n >= 2);
  if (paired) {
    const pairIds = labels.filter((l) => l.state === paired[0]).map((l) => l.id);
    if (pairIds.every((id) => rows.some((r) => r.id === id)))
      pass(`⭐ cardinality survives: state '${paired[0]}' has ${paired[1]} presets and ALL render — the revert's defect stays dead`);
    else fail('same-state pair', `missing rows of the '${paired[0]}' pair`);
  } else note('no same-state pair on this stand — the pair claim rests on jsdom');

  const below = await p.$eval(inMenu('presence-offline'), (off) => {
    const first = document.querySelector('[data-testid^="status-preset-"]');
    return first ? Boolean(off.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) : false;
  });
  if (below) pass('…and the presets sit BELOW the four states — «ниже четырёх базовых»');
  else fail('preset placement', 'a preset renders before the last state');

  // ── screenshots of the OPEN menu, both themes, through the PRODUCT control ─────────────────────
  await p.screenshot({ path: `${SHOTS}/w22dop-menu-light.png` });
  await p.keyboard.press('Escape');
  await p.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.click('[data-testid="theme-dark"]');
  await p.waitForTimeout(1500);
  // The dark frame must be the PRODUCT's dark — chrome included — not a stylesheet mid-swap.
  await p.waitForFunction(() => document.documentElement.classList.contains('dark'), undefined, { timeout: 8000 });
  await openMenu(p);
  await p.screenshot({ path: `${SHOTS}/w22dop-menu-dark.png` });
  await p.keyboard.press('Escape');
  await p.click('[data-testid="theme-light"]');
  await p.waitForTimeout(1000);
  pass('both-theme screenshots of the open menu taken through the product control, theme restored');

  // Off /settings before touching states: its page-level presence control shares the menu's testids.
  await p.goto(`${WEB}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="user-menu-trigger"]', { timeout: 20000 });

  // ── 3+4: choosing a preset — the pair survives a reload, and the server says so ────────────────
  const chosen = labels[0];
  await openMenu(p);
  await p.click(`[data-testid="status-preset-${chosen.id}"]`);
  await p.waitForTimeout(1500);
  const dotAfter = await p.getAttribute('[data-testid="presence-dot"]', 'data-state');
  if (dotAfter === chosen.state) pass(`choosing «${chosen.name}» wears its state at once: ${dotAfter}`);
  else fail('optimistic dot', `${dotAfter} (wanted ${chosen.state})`);

  await p.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="user-menu-trigger"]', { timeout: 20000 });
  await p.waitForTimeout(1000);
  const dotReloaded = await p.getAttribute('[data-testid="presence-dot"]', 'data-state');
  await openMenu(p);
  const rowsReloaded = await presetRows(p);
  const currentRow = rowsReloaded.find((r) => r.current);
  if (dotReloaded === chosen.state && currentRow?.id === chosen.id)
    pass('⭐ a RELOAD keeps both facts — the state on the dot, the ✓ on the preset. A server fact, not client memory');
  else fail('reload', `dot ${dotReloaded}, current ${currentRow?.id ?? 'none'} (wanted ${chosen.state}, ${chosen.id})`);
  const baseCurrent = await p.getAttribute(inMenu(`presence-${chosen.state}`), 'aria-current');
  if (baseCurrent !== 'true') pass('…and the base state row YIELDS the ✓ — one row asserts the fact, not two');
  else fail('one ✓ only', 'the base row claims current while a preset is active');

  const onWire = await presenceOf();
  if (onWire?.state === chosen.state && onWire?.labelId === chosen.id)
    pass(`⭐ the server carries the PAIR: state=${onWire.state}, labelId=${onWire.labelId} — the reason recorded WITH the behaviour`);
  else fail('server pair', JSON.stringify(onWire ?? null));

  // ── 5: a bare state clears the label ────────────────────────────────────────────────────────────
  await p.click(inMenu('presence-online'));
  await p.waitForTimeout(1500);
  const cleared = await presenceOf();
  if (cleared?.state === 'online' && !cleared?.labelId)
    pass('⭐ a bare state CLEARS the label on the server — «On shift» after a preset is a real write');
  else fail('bare state clears', JSON.stringify(cleared ?? null));

  // ── 6: a STALE preset is refused, and the badge goes back ──────────────────────────────────────
  const tmp = await api('POST', '/presence/labels', { name: `w22dop stale ${Date.now().toString(36)}`, state: 'away' });
  const tmpId = tmp.json?.id;
  if (!tmpId) throw new Error(`could not create the temp label: ${tmp.status}`);
  await p.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="user-menu-trigger"]', { timeout: 20000 });
  await openMenu(p);
  await p.waitForSelector(`[data-testid="status-preset-${tmpId}"]`, { timeout: 8000 });
  await api('DELETE', `/presence/labels/${tmpId}`);
  await p.click(`[data-testid="status-preset-${tmpId}"]`);
  await p.waitForTimeout(2000);
  const dotStale = await p.getAttribute('[data-testid="presence-dot"]', 'data-state');
  if (dotStale === 'online')
    pass('⭐ a preset deleted UNDER the open menu is refused — the dot goes back, the badge never lies about routing');
  else fail('stale preset refusal', `dot ${dotStale} (wanted online back)`);

  if (errors.length === 0) pass('no uncaught page errors during the whole pass');
  else fail('page errors', errors.slice(0, 2).join(' | '));
} catch (err) {
  fail('the pass could not run', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW22dop browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
