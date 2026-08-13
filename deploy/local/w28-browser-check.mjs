/**
 * W28 browser check — Access Management: roles and permissions in ONE window (R45 / 9.8).
 *
 *   1  ⛔ a non-super-admin does not open the section BY LINK (refusal panel) nor BY REQUEST (403)
 *   2  ⭐ the toggle is a convenience and the SERVER forbids: the agent's own direct write → 403
 *   3  ⭐ a right granted in the window acts IN THE SAME SESSION: the agent's open session gains
 *      `crm.customers.browse` (403 → 200 on /players) the moment the super-admin flips the switch
 *   4  the same window changes the ROLE (staff-role write from the person header)
 *   5  «вернуть как было» live: reset → the agent is back to defaults → 403 again
 *   6  ⭐ every change is in the journal: permission.grant + permission.reset + role.assign
 *   + light and dark screenshots of the window, person scope, through the product theme control
 *
 * Stand prep this script assumes (deploy notes, W27's lesson): the super-admin login
 * warden@beton.win must have a REAL credential hash on crm-next (the seed leaves a placeholder) —
 * write it with the argon2-in-auth-container technique before running.
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
const OWNER = process.env.OWNER_EMAIL ?? 'warden@beton.win';
const OWNER_PW = process.env.OWNER_PASSWORD ?? '';
const SHOTS = process.env.SHOT_DIR ?? '/tmp/pw-work/shots';
const KEY = 'platform.audit.view';
/**
 * The probe surface must be SINGLE-TIER on the key: /players carries a second, ROLE-tier guard in
 * the users service (Q34's defence-in-depth), so a personalised support_agent passes the gateway
 * and still 403s — a granted key that "does not work" for reasons that are the product being
 * right. The audit read is gated on exactly this key at every hop, so 403→200→403 means the KEY.
 */
const PROBE_PATH = '/audit?pageSize=5';

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

async function signIn(p, email, password) {
  await p.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.fill('input[type="email"]', email);
  await p.fill('input[type="password"]', password);
  await p.click('button[type="submit"]');
  await p.waitForTimeout(2500);
  await p.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(email));
  await p.click('button[type="submit"]');
  await p.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
}

const browser = await chromium.launch();
try {
  const creds = process.env.EDGE_USER
    ? { httpCredentials: { username: process.env.EDGE_USER, password: process.env.EDGE_PASSWORD ?? '' } }
    : {};

  // ── the three parties ───────────────────────────────────────────────────────────────────────────
  const agentApi = await apiSession(AGENT, AGENT_PW);          // the SESSION that must gain the right
  const adminApi = await apiSession(ADMIN, ADMIN_PW);          // role admin — NOT super_admin
  const ownerApi = await apiSession(OWNER, OWNER_PW);          // super_admin — the window's subject
  const users = await adminApi('GET', '/admin/access/users');
  const agentRow = (users.json?.users ?? []).find((u) => u.email === AGENT);
  const agentId = agentRow?.userId ?? agentRow?.id;
  if (!agentId) throw new Error('could not resolve the agent user id');

  // Self-heal the fixture THROUGH THE PRODUCT (the w23 lesson): an earlier run or probe may have
  // left the agent personalised, and a polluted baseline reads as a wrong claim, not as history.
  await ownerApi('POST', '/admin/access/reset', { scope: 'user', userId: agentId });

  // Baseline: the agent's defaults do NOT include the key.
  const before = await agentApi('GET', PROBE_PATH);
  if (before.status === 403) pass('baseline: the agent’s session is refused the audit log (403)');
  else fail('baseline', `${before.status}`);

  // ── 1: a non-super-admin — by request, then by link ────────────────────────────────────────────
  const catAsAdmin = await adminApi('GET', '/admin/access/catalogue');
  if (catAsAdmin.status === 403) pass('⛔ by REQUEST: role admin gets 403 on the section’s reads (server tier)');
  else fail('admin catalogue', `${catAsAdmin.status}`);
  const writeAsAdmin = await adminApi('PUT', `/admin/access/users/${agentId}/permissions`, { permissionKey: KEY, grant: true });
  if (writeAsAdmin.status === 403) pass('⛔ …and 403 on the writes — admin is deliberately not super_admin (FR-018)');
  else fail('admin write', `${writeAsAdmin.status}`);

  const ctxAdmin = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const pAdmin = await ctxAdmin.newPage();
  await signIn(pAdmin, ADMIN, ADMIN_PW);
  await pAdmin.goto(`${WEB}/admin/access`, { waitUntil: 'networkidle', timeout: 30000 });
  if (await pAdmin.$('[data-testid="access-denied"]')) pass('⛔ by LINK: the admin sees the refusal panel, not the window');
  else fail('admin by link', 'the window rendered');
  await ctxAdmin.close();

  // ── 2: the toggle is a convenience — the SERVER forbids ────────────────────────────────────────
  const selfGrant = await agentApi('PUT', `/admin/access/users/${agentId}/permissions`, { permissionKey: KEY, grant: true });
  if (selfGrant.status === 403) pass('⭐ the agent’s own direct write is refused — the toggle is UI, the server is the law');
  else fail('agent self-grant', `${selfGrant.status}`);

  // ── 3+4: the super-admin's window — grant in the grid, the agent's session gains it ────────────
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await signIn(p, OWNER, OWNER_PW);
  await p.goto(`${WEB}/admin/access`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="access-window"]', { timeout: 20000 });
  pass('the super-admin opens the ONE window');

  await p.fill('[data-testid="people-search"]', AGENT);
  await p.click(`[data-testid="person-${agentId}"]`);
  await p.waitForSelector(`[data-testid="switch-${KEY}"]`, { timeout: 20000 });
  await p.screenshot({ path: `${SHOTS}/w28-window-light.png` });
  await p.click(`[data-testid="switch-${KEY}"]`);
  // The window re-reads the person after the write; the switch lands checked from the SERVER.
  await p.waitForFunction(
    (key) => document.querySelector(`[data-testid="switch-${key}"]`)?.getAttribute('data-state') === 'checked',
    KEY,
    { timeout: 15000 },
  );
  pass('the switch flipped — and what it shows is the re-read server truth, not local optimism');

  const after = await agentApi('GET', PROBE_PATH);
  if (after.status === 200) pass('⭐⭐ THE SAME SESSION: the agent’s open session now reads the audit log (403 → 200, no re-login)');
  else fail('same-session grant', `${after.status}`);

  // The badge the engine warned about: the person is now personalised, and the window says so.
  if (await p.$('[data-testid="mode-standalone"]')) pass('…and the window says the person is now personalised (the W14 lesson, on screen)');
  else fail('personalised badge', 'not shown after a personalizing write');

  // ── 4: the role, from the same header ───────────────────────────────────────────────────────────
  await p.keyboard.press('Escape');
  await p.click('[data-testid="role-menu"]');
  const superOption = await p.$('[data-testid="assign-role-super_admin"]');
  if (!superOption) pass('⛔ super_admin is not an option anywhere in the window (0033 whitelist)');
  else fail('super_admin offered', 'the menu lists it');
  await p.click('[data-testid="assign-role-vip_support"]');
  await p.waitForFunction(
    () => document.querySelector('[data-testid="role-menu"]')?.textContent?.includes('vip_support'),
    undefined,
    { timeout: 15000 },
  );
  pass('the ROLE changed from the same window — one mechanism, as R45 asked');
  // …and back, so the stand's fixture keeps its shape for the next run.
  await p.click('[data-testid="role-menu"]');
  await p.click('[data-testid="assign-role-support_agent"]');
  await p.waitForTimeout(1500);

  // ── dark screenshot through the product control ─────────────────────────────────────────────────
  await p.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.click('[data-testid="theme-dark"]');
  await p.waitForFunction(() => document.documentElement.classList.contains('dark'), undefined, { timeout: 8000 });
  await p.goto(`${WEB}/admin/access`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="access-window"]', { timeout: 20000 });
  await p.fill('[data-testid="people-search"]', AGENT);
  await p.click(`[data-testid="person-${agentId}"]`);
  await p.waitForSelector(`[data-testid="switch-${KEY}"]`, { timeout: 20000 });
  await p.waitForTimeout(600); // settle past --motion-base (a-screenshot-is-one-frame)
  await p.screenshot({ path: `${SHOTS}/w28-window-dark.png` });
  await p.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.click('[data-testid="theme-light"]');
  await p.waitForTimeout(1000);
  pass('both-theme screenshots taken through the product control, theme restored');

  // ── 5: «вернуть как было», live ─────────────────────────────────────────────────────────────────
  await p.goto(`${WEB}/admin/access`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="access-window"]', { timeout: 20000 });
  await p.fill('[data-testid="people-search"]', AGENT);
  await p.click(`[data-testid="person-${agentId}"]`);
  await p.waitForSelector('[data-testid="reset-scope"]', { timeout: 20000 });
  await p.click('[data-testid="reset-scope"]');
  await p.waitForFunction(
    () => !document.querySelector('[data-testid="mode-standalone"]'),
    undefined,
    { timeout: 15000 },
  );
  pass('reset: the personalised badge left — the person inherits their role again');

  const reverted = await agentApi('GET', PROBE_PATH);
  if (reverted.status === 403) pass('⭐ …and the agent’s SAME session lost the right with the reset (200 → 403)');
  else fail('same-session reset', `${reverted.status}`);

  // ── 6: the journal holds every change ───────────────────────────────────────────────────────────
  const trail = await ownerApi('GET', `/audit?targetRef=${agentId}`);
  const acts = (trail.json?.entries ?? trail.json?.items ?? []).map((e) => e.action);
  const wanted = ['permission.grant', 'permission.reset', 'role.assign'];
  if (wanted.every((w) => acts.includes(w)))
    pass(`⭐ the journal names all three acts (${wanted.join(' + ')}) — nothing moved unrecorded`);
  else fail('journal', JSON.stringify(acts).slice(0, 160));

  if (errors.length === 0) pass('no uncaught page errors during the whole pass');
  else fail('page errors', errors.slice(0, 2).join(' | '));
  await ctx.close().catch(() => {});
} catch (err) {
  fail('the pass could not run', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW28 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
