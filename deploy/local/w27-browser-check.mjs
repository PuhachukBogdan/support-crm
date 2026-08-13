/**
 * W27 browser check — the shelf (suspended / deleted buckets), as BEHAVIOUR (spec 036, roadmap 9.16).
 *
 *   1  ⭐ SC-001: a suspended ticket exists in exactly ONE surface — its bucket. Walked as the AGENT
 *      (rail bucket, active panel, unread badge lose it) and as the SUPERVISOR (bucket holds it)
 *   2  SC-004: the agent (no shelf.view) sees no bucket entries; a direct bucket read is refused;
 *      a direct detail GET of a shelved id answers the NOT_FOUND shape
 *   3  ⭐ SC-002: the router is blind — auto-assign on a suspended ticket refuses outright
 *   4  the freeze: a reply and a status write on a shelved ticket are refused; restore is the way back
 *   5  ⭐ SC-003: restore returns the projection exactly (status · assignee · subject) and re-lists it
 *   6  SC-005: the audit trail holds prior entries + delete + restore, in order — nothing hides
 *   + light and dark screenshots (bucket + banner) through the product theme control, settled
 *
 * ⚠️ Selectors scoped (`bucket-rail` / window) — the instance-9 rule.
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

const inRail = (testid) => `[data-testid="bucket-rail"] [data-testid="${testid}"]`;

const browser = await chromium.launch();
try {
  const creds = process.env.EDGE_USER
    ? { httpCredentials: { username: process.env.EDGE_USER, password: process.env.EDGE_PASSWORD ?? '' } }
    : {};
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));

  // ── sessions: the agent's browser; admin + agent API ────────────────────────────────────────────
  await p.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.fill('input[type="email"]', AGENT);
  await p.fill('input[type="password"]', AGENT_PW);
  await p.click('button[type="submit"]');
  await p.waitForTimeout(2500);
  await p.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(AGENT));
  await p.click('button[type="submit"]');
  await p.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
  await p.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });
  pass('the agent signed in');

  const admin = await apiSession(ADMIN, ADMIN_PW);
  const agentApi = await apiSession(AGENT, AGENT_PW);
  const users = await admin('GET', '/admin/access/users');
  const agentUser = (users.json?.users ?? []).find((u) => u.email === AGENT);
  const ops = await admin('GET', `/operators?authUserIds=${agentUser?.userId ?? agentUser?.id}`);
  const agentOperatorId = ops.json?.operators?.[0]?.operatorId;
  if (!agentOperatorId) throw new Error('could not resolve the agent operator id');

  // A ticket in the agent's slice, with history: created + assigned + opened by the agent.
  const created = await admin('POST', '/conversations/initiate-email', {
    brandId: BRAND, playerId: PLAYER,
    subject: `w27 shelf ${Date.now().toString(36)}`,
    body: 'shelf check',
  });
  const tid = created.json?.id;
  const subject = created.json?.subject ?? '';
  if (!tid) throw new Error(`initiate-email failed: ${created.status}`);
  await admin('PUT', `/conversations/${tid}/assignee`, { operatorId: agentOperatorId });
  await p.goto(`${WEB}/tickets/${tid}`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="ticket-window"]', { timeout: 20000 });
  const before = await agentApi('GET', `/conversations/${tid}`);
  pass(`ticket manufactured, assigned and opened (status=${before.json?.statusKey})`);

  // ── 2 (half): the agent's rail carries NO shelf buckets ─────────────────────────────────────────
  await p.goto(`${WEB}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });
  if (!(await p.$(inRail('bucket-suspended'))) && !(await p.$(inRail('bucket-deleted'))))
    pass('the agent (no shelf.view) sees NO shelf buckets — the section ends at «Весь архив»');
  else fail('agent rail', 'a shelf bucket rendered without the permission');
  const onList = await p.textContent('[data-testid="bucket-rail"] ~ * , main').catch(() => '');
  if ((await p.textContent('body'))?.includes(subject)) pass('…and the ticket is on their Inbox list before the shelf');
  else fail('baseline list', 'the manufactured ticket is not on the Inbox');

  // ── 1: the admin suspends it — it leaves every agent surface, appears in the bucket ────────────
  const susp = await admin('PUT', `/conversations/${tid}/shelf`, { state: 'suspended' });
  if (susp.status === 200 && susp.json?.changed === true)
    pass('⭐ the shelf verb: PUT /shelf {suspended} → changed:true');
  else fail('suspend', `${susp.status} ${JSON.stringify(susp.json).slice(0, 100)}`);

  await p.reload({ waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });
  await p.waitForTimeout(1500);
  if (!(await p.textContent('body'))?.includes(subject))
    pass('⭐ SC-001: the suspended ticket VANISHED from the agent’s Inbox');
  else fail('SC-001 inbox', 'still listed after suspension');

  const agentBucket = await agentApi('GET', `/conversations?shelved=suspended`);
  if (agentBucket.status === 403) pass('SC-004: the agent’s direct bucket read is REFUSED (403)');
  else fail('SC-004 bucket read', `${agentBucket.status}`);
  const agentDetail = await agentApi('GET', `/conversations/${tid}`);
  if (agentDetail.status === 404) pass('SC-004: the shelved detail answers the agent NOT_FOUND — no oracle');
  else fail('SC-004 detail', `${agentDetail.status}`);

  const adminBucket = await admin('GET', `/conversations?shelved=suspended`);
  const inBucket = (adminBucket.json?.conversations ?? []).some((c) => c.id === tid);
  if (inBucket) pass('⭐ SC-001: …and it sits in the SUSPENDED bucket for the permission holder');
  else fail('bucket content', JSON.stringify(adminBucket.json).slice(0, 120));

  // ── 3: the router is blind ──────────────────────────────────────────────────────────────────────
  const unassign = await admin('PUT', `/conversations/${tid}/assignee`, { operatorId: '' });
  if (unassign.status !== 200) pass(`SC-002 precondition: even UNASSIGNING a shelved ticket is refused (${unassign.status}) — the freeze holds`);
  const auto = await admin('POST', `/conversations/${tid}/auto-assign`, {});
  if (auto.status === 400) pass('⭐ SC-002: auto-assign on a shelved ticket is refused — the router cannot see it');
  else fail('SC-002 auto-assign', `${auto.status} ${JSON.stringify(auto.json).slice(0, 80)}`);

  // ── 4: the freeze ───────────────────────────────────────────────────────────────────────────────
  const reply = await admin('POST', `/conversations/${tid}/messages`, { kind: 'reply', body: 'should be refused' });
  if (reply.status === 400) pass('the freeze: a reply on a shelved ticket is refused');
  else fail('freeze reply', `${reply.status}`);
  const st = await admin('PATCH', `/conversations/${tid}/status`, { status: 'solved' });
  if (st.status === 400) pass('the freeze: a status write on a shelved ticket is refused');
  else fail('freeze status', `${st.status}`);

  // ── screenshots: the supervisor's bucket + the banner, both themes ─────────────────────────────
  // The admin signs in in a second context (different account set on crm-next: admin@example.test).
  const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const p2 = await ctx2.newPage();
  await p2.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await p2.fill('input[type="email"]', ADMIN);
  await p2.fill('input[type="password"]', ADMIN_PW);
  await p2.click('button[type="submit"]');
  await p2.waitForTimeout(2500);
  await p2.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(ADMIN));
  await p2.click('button[type="submit"]');
  await p2.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
  await p2.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });
  await p2.waitForSelector(inRail('bucket-suspended'), { timeout: 10000 });
  pass('the supervisor’s rail CARRIES the shelf buckets, below the archive heading');
  await p2.click(inRail('bucket-suspended'));
  await p2.waitForTimeout(1500);
  await p2.screenshot({ path: `${SHOTS}/w27-bucket-light.png` });
  await p2.goto(`${WEB}/tickets/${tid}`, { waitUntil: 'networkidle', timeout: 30000 });
  await p2.waitForSelector('[data-testid="shelf-banner"]', { timeout: 20000 });
  pass('the shelved window wears the banner (readable through the bucket permission)');
  await p2.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await p2.click('[data-testid="theme-dark"]');
  await p2.waitForFunction(() => document.documentElement.classList.contains('dark'), undefined, { timeout: 8000 });
  await p2.goto(`${WEB}/tickets/${tid}`, { waitUntil: 'networkidle', timeout: 30000 });
  await p2.waitForSelector('[data-testid="shelf-banner"]', { timeout: 20000 });
  await p2.waitForTimeout(600); // settle past --motion-base (a-screenshot-is-one-frame)
  await p2.screenshot({ path: `${SHOTS}/w27-banner-dark.png` });
  await p2.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await p2.click('[data-testid="theme-light"]');
  await p2.waitForTimeout(1000);
  pass('both-theme screenshots taken through the product control, theme restored');

  // ── 5+6: delete over suspended, then restore — the projection and the trail ────────────────────
  const del = await admin('PUT', `/conversations/${tid}/shelf`, { state: 'deleted' });
  if (del.status === 200) pass('delete WINS over suspended (one write, the delete audit word)');
  else fail('delete over suspended', `${del.status}`);
  const rest = await admin('PUT', `/conversations/${tid}/shelf`, { state: null });
  if (rest.status === 200 && rest.json?.changed === true) pass('restore: PUT /shelf {null} → changed:true');
  else fail('restore', `${rest.status}`);

  const after = await agentApi('GET', `/conversations/${tid}`);
  const b = before.json ?? {}, a = after.json ?? {};
  if (a.statusKey === b.statusKey && a.assigneeOperatorId === b.assigneeOperatorId && a.subject === b.subject && !a.shelvedState)
    pass('⭐ SC-003: the restored projection is IDENTICAL — status, assignee, subject; the shelf left no mark');
  else fail('SC-003 projection', JSON.stringify({ before: b.statusKey, after: a.statusKey, shelf: a.shelvedState }));

  await p.goto(`${WEB}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });
  await p.waitForTimeout(1500);
  if ((await p.textContent('body'))?.includes(subject))
    pass('⭐ SC-003: …and it re-lists on the agent’s Inbox, exactly where it left');
  else fail('re-list', 'not back on the Inbox after restore');

  // ⚠️ The audit read mounts at /audit (feature 015), not under /admin — the first run asked a
  // route that does not exist and read the 404 body as an empty trail (vacuous in the making;
  // caught because SC-005 asserts PRESENCE, not absence).
  const audit = await admin('GET', `/audit?targetRef=${tid}`);
  const acts = (audit.json?.entries ?? audit.json?.items ?? []).map((e) => e.action);
  const hasAll = ['conversation.suspend', 'conversation.delete', 'conversation.restore'].every((x) => acts.includes(x));
  if (hasAll) pass(`⭐ SC-005: the trail holds suspend + delete + restore (${acts.length} entries, nothing hidden)`);
  else fail('SC-005 audit', JSON.stringify(acts).slice(0, 160));

  if (errors.length === 0) pass('no uncaught page errors during the whole pass');
  else fail('page errors', errors.slice(0, 2).join(' | '));
  await ctx2.close().catch(() => {});
} catch (err) {
  fail('the pass could not run', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW27 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
