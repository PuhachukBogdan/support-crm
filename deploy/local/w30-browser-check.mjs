/**
 * W30 browser check — custom ticket fields, forms & option sets (roadmap 4.15, spec 037), as BEHAVIOUR.
 *
 *   1  ⭐ the admin AUTHORS on /admin/fields — an option set, a dropdown field bound to it, a form
 *      carrying a category — and the wire re-read shows the same structure; the journal holds the
 *      three `*.config_changed` actions
 *   2  ⭐ the agent FILLS the seeded Deposits cascade on a ticket: form → L1 → L2 appears → L3 —
 *      and the RESERVED COLUMNS hold it (category = Deposits, sub_category = the L1 value,
 *      classified_by = the operator, never 'ai') — the receipt is the server's state
 *   3  ⛔ refusals in words: text into a numeric field · a value outside the option set · solve
 *      with an empty required field (names the key) — then filling it makes the same solve pass
 *   4  ⛔ restricted probe (positive control FIRST): the teamlead sees the flagged field, the agent's
 *      payload carries NEITHER definition NOR value, and the agent's write gets the SAME refusal an
 *      unknown key gets (no oracle); the fixture self-heals through the product
 *   5  idempotence: the identical value twice — both 200, the stored state unchanged
 *   6  a ticket with NO form renders exactly as before (no field rows, no gate)
 *   + light and dark screenshots of both surfaces through the product theme control
 *
 * Roles on crm-next: warden@beton.win (super_admin — authors), role-teamlead (clearance),
 * role-support-agent (fills). Run ON THE STAND against the VERIFICATION origin (rule 12).
 * ⚠️ Requires the auth RE-SEED first (two new permission keys) + «making the login usable».
 */
import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-next.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.2:8025';
const AGENT = process.env.PROBE_EMAIL ?? 'role-support-agent@beton.win';
const AGENT_PW = process.env.PROBE_PASSWORD ?? 'Stand#Role7x';
const LEAD = process.env.LEAD_EMAIL ?? 'role-teamlead@beton.win';
const LEAD_PW = process.env.LEAD_PASSWORD ?? 'Stand#Role7x';
const ADMIN = process.env.ADMIN_EMAIL ?? 'admin@example.test';
const ADMIN_PW = process.env.ADMIN_PASSWORD ?? '';
const OWNER = process.env.OWNER_EMAIL ?? 'warden@beton.win';
const OWNER_PW = process.env.OWNER_PASSWORD ?? '';
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

/** The receipt is the SERVER's state: poll the read until it holds the value, or say it never did. */
async function until(readFn, predicate, what, tries = 10) {
  for (let i = 0; i < tries; i += 1) {
    const res = await readFn();
    if (predicate(res)) return res;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error(`the server never held: ${what}`);
}

const RUN = Date.now().toString(36);
const SET_NAME = `w30 proof values ${RUN}`;
const FIELD_LABEL = `w30 proof topic ${RUN}`;
const FORM_NAME = `w30 proof ${RUN}`;

const browser = await chromium.launch();
try {
  const creds = process.env.EDGE_USER
    ? { httpCredentials: { username: process.env.EDGE_USER, password: process.env.EDGE_PASSWORD ?? '' } }
    : {};

  const agentApi = await apiSession(AGENT, AGENT_PW);
  const leadApi = await apiSession(LEAD, LEAD_PW);
  const adminApi = await apiSession(ADMIN, ADMIN_PW);
  const ownerApi = await apiSession(OWNER, OWNER_PW);

  // ── authoring is the server's law before it is anyone's screen ─────────────────────────────────
  const agentPost = await agentApi('POST', '/admin/field-config/fields', { label: 'sneaky', type: 'text' });
  if (agentPost.status === 403) pass('⛔ the agent’s direct POST /admin/field-config/fields is 403 — the SERVER refuses authoring');
  else fail('agent authoring', `${agentPost.status}`);
  const agentRead = await agentApi('GET', '/admin/field-config');
  if (agentRead.status === 403) pass('⛔ …and the authoring READ is 403 for the agent too');
  else fail('agent config read', `${agentRead.status}`);

  // ── 1: the admin authors ON THE SCREEN ──────────────────────────────────────────────────────────
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await signIn(p, OWNER, OWNER_PW);
  pass('the owner signed in (breadcrumb)');
  await p.goto(`${WEB}/admin/fields`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="tab-fields"]', { timeout: 20000 });
  pass('the /admin/fields screen is open (breadcrumb)');

  // A set, on the sets tab. (Radix things open via KEYBOARD — the w29 lesson: a programmatic click
  // on a trigger can open-and-close in one event; Enter is the guaranteed, accessible path.)
  await p.click('[data-testid="tab-sets"]');
  await p.click('[data-testid="set-new"]');
  await p.fill('[data-testid="set-name"]', SET_NAME);
  // The editor opens with ONE empty row; each «+ Add value» appends another.
  await p.fill('[data-testid="set-value-0"]', 'Alpha');
  await p.click('[data-testid="set-add-value"]');
  await p.fill('[data-testid="set-value-1"]', 'Beta');
  await p.click('[data-testid="set-save"]');
  await p.waitForSelector(`text=${SET_NAME}`, { timeout: 15000 });
  pass('⭐ an option set authored on the screen — two values, ordered');

  // A dropdown field bound to it, required.
  await p.click('[data-testid="tab-fields"]');
  await p.click('[data-testid="field-new"]');
  await p.fill('[data-testid="field-label"]', FIELD_LABEL);
  await p.selectOption('[data-testid="field-type"]', 'dropdown');
  await p.selectOption('[data-testid="field-option-set"]', { label: SET_NAME });
  // A Radix checkbox is a button with role=checkbox — click, don't `check()` (no input element).
  await p.click('[data-testid="field-required"]');
  await p.click('[data-testid="field-save"]');
  await p.waitForSelector(`text=${FIELD_LABEL}`, { timeout: 15000 });
  pass('⭐ a required dropdown field authored, bound to the set');

  // A form carrying a category, with the field as its sub-category source.
  await p.click('[data-testid="tab-forms"]');
  await p.click('[data-testid="form-new"]');
  await p.fill('[data-testid="form-name"]', FORM_NAME);
  await p.fill('[data-testid="form-category"]', `w30cat ${RUN}`);
  await p.click('[data-testid="form-save"]');
  await p.waitForSelector(`text=${FORM_NAME}`, { timeout: 15000 });
  pass('⭐ a category-bearing form authored on the screen');

  // The wire re-read shows the same structure — the screen did not imagine it.
  const cfg = (await ownerApi('GET', '/admin/field-config')).json;
  const wireSet = (cfg?.optionSets ?? []).find((s) => s.name === SET_NAME);
  const wireField = (cfg?.fields ?? []).find((f) => f.label === FIELD_LABEL);
  const wireForm = (cfg?.forms ?? []).find((f) => f.name === FORM_NAME);
  if (wireSet && (wireSet.values ?? []).map((v) => v.value).join(',') === 'Alpha,Beta'
      && wireField?.type === 'dropdown' && wireField?.required === true && wireField?.optionSetId === wireSet.id
      && wireForm?.category === `w30cat ${RUN}`)
    pass('⭐ the wire re-read holds exactly what was authored (set → field → form)');
  else fail('wire re-read', JSON.stringify({ set: !!wireSet, field: wireField, form: wireForm }).slice(0, 200));

  // The journal holds the three config actions.
  const trail = (await ownerApi('GET', '/audit?limit=50')).json?.entries ?? [];
  const actions = new Set(trail.map((e) => e.action));
  if (['field.config_changed', 'option_set.config_changed', 'form.config_changed'].every((a) => actions.has(a)))
    pass('⭐ the journal carries field/option_set/form.config_changed with the actor');
  else fail('journal actions', [...actions].join(',').slice(0, 160));

  // ── 2: the agent fills the seeded Deposits cascade; the reserved columns hold it ───────────────
  const conv = await adminApi('POST', '/conversations/initiate-email', {
    brandId: BRAND, playerId: PLAYER,
    subject: `w30 cascade ${RUN}`, body: 'fields check',
  });
  const tid = conv.json?.id;
  if (!tid) throw new Error(`initiate-email failed: ${conv.status}`);

  const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errors.push(String(e)));
  await signIn(p2, AGENT, AGENT_PW);
  await p2.goto(`${WEB}/tickets/${tid}`, { waitUntil: 'networkidle', timeout: 30000 });
  await p2.waitForSelector('[data-testid="field-form"]', { timeout: 20000 });

  // Radix dropdowns open via Enter (the w29 lesson), values are chosen from the menu by text.
  await p2.press('[data-testid="field-form"]', 'Enter');
  await p2.click('text=Deposits');
  await p2.waitForSelector('[data-testid="cf-l1_deposits"]', { timeout: 15000 });
  pass('⭐ the Deposits form chosen — its fields appeared in the column');

  await p2.press('[data-testid="cf-input-l1_deposits"]', 'Enter');
  await p2.click('text=Deposit status');
  await p2.waitForSelector('[data-testid="cf-l2_deposit_status"]', { timeout: 15000 });
  pass('⭐ L1 chosen → L2 appeared (the cascade narrows)');
  await p2.press('[data-testid="cf-input-l2_deposit_status"]', 'Enter');
  await p2.click('text=Declined');
  await p2.waitForSelector('[data-testid="cf-l3_deposit_declined"]', { timeout: 15000 });
  await p2.press('[data-testid="cf-input-l3_deposit_declined"]', 'Enter');
  await p2.click('text=Timeout');
  pass('⭐ L2 → L3 → Timeout — the frame-032 walk, on our screen');

  // The reserved columns, from the wire — the receipt is the server's state, not the click.
  const detail = await until(
    () => agentApi('GET', `/conversations/${tid}`),
    (r) => r.json?.category === 'Deposits' && r.json?.subCategory === 'Deposit status',
    'category=Deposits ∧ subCategory=Deposit status',
  );
  if (detail.json?.classifiedBy && detail.json.classifiedBy !== 'ai')
    pass(`⭐ the reserved columns hold the tree WITH the U9 lock: classified_by=${detail.json.classifiedBy}`);
  else fail('U9 lock', JSON.stringify({ by: detail.json?.classifiedBy }));

  // ── 3: refusals + the gate. ⚠️ The REST edge is MESSAGE-FREE by the product's own SC-007 rule
  // (`gateway/src/chats/rpc.ts` flattens refusal detail), so the WORDS are asserted at the service
  // tier (unit suites) and on the SCREEN (the required-hint below); here the wire proves the CLASS
  // of refusal and — the receipt rule — that the stored state did not move.
  const notNumber = await agentApi('PATCH', `/conversations/${tid}/fields/deposit_amount`, { value: 'abc' });
  const offSet = await agentApi('PATCH', `/conversations/${tid}/fields/country`, { value: 'Atlantis' });
  const heldAfter = await agentApi('GET', `/conversations/${tid}/fields`);
  const heldKeys = (heldAfter.json?.values ?? []).map((v) => v.fieldKey);
  if (notNumber.status === 400 && offSet.status === 400
      && !heldKeys.includes('deposit_amount') && !heldKeys.includes('country'))
    pass('⛔ text into numeric · out-of-set value — both 400, NOTHING stored (fail-closed on the wire)');
  else fail('value refusals', `${notNumber.status}/${offSet.status} held=${heldKeys.join(',')}`);

  // The screen NAMES the empty required fields before any refusal — the hint is the worded half.
  const hint = await p2.textContent('[data-testid="custom-fields-required-hint"]').catch(() => '');
  if ((hint ?? '').includes('Country'))
    pass('⭐ the SCREEN names the empty required field (Country) — words live where SC-007 allows them');
  else fail('required hint', String(hint).slice(0, 80));

  const solveBlocked = await agentApi('PATCH', `/conversations/${tid}/status`, { status: 'solved' });
  const stillOpen = await agentApi('GET', `/conversations/${tid}`);
  if (solveBlocked.status === 400 && stillOpen.json?.statusKey !== 'solved')
    pass('⛔ solve with an empty required field — refused, and the stored status did not move');
  else fail('solve gate', `${solveBlocked.status} status=${stillOpen.json?.statusKey}`);
  await agentApi('PATCH', `/conversations/${tid}/fields/country`, { value: 'Argentina' });
  const solveNow = await agentApi('PATCH', `/conversations/${tid}/status`, { status: 'solved' });
  const nowSolved = await agentApi('GET', `/conversations/${tid}`);
  if (solveNow.status === 200 && nowSolved.json?.statusKey === 'solved')
    pass('…filled — the SAME solve passes (required-to-solve, never required-to-save)');
  else fail('solve after fill', `${solveNow.status} status=${nowSolved.json?.statusKey}`);
  await agentApi('PATCH', `/conversations/${tid}/status`, { status: 'open' }); // back to work for the steps below

  // ── 4: the restricted probe — positive control FIRST, no oracle, self-healing fixture ──────────
  const flag = (restricted) => adminApi('PATCH', '/admin/field-config/fields/country', {
    label: 'Country', type: 'dropdown', optionSetId: 'seed-oset-countries',
    required: true, restricted, active: true,
  });
  const flagged = await flag(true);
  if (flagged.status === 200) pass('the admin flagged `country` restricted (through the product)');
  else fail('flagging', `${flagged.status}`);
  const leadView = await leadApi('GET', `/conversations/${tid}/fields`);
  const leadHas = (leadView.json?.entries ?? []).some((e) => e.field?.key === 'country');
  if (leadHas) pass('the TEAMLEAD sees the restricted field — the positive control comes first');
  else fail('teamlead clearance', JSON.stringify(leadView.json?.entries?.map((e) => e.field?.key)).slice(0, 120));
  const agentView = await agentApi('GET', `/conversations/${tid}/fields`);
  const agentEntries = (agentView.json?.entries ?? []).map((e) => e.field?.key);
  const agentValues = (agentView.json?.values ?? []).map((v) => v.fieldKey);
  if (!agentEntries.includes('country') && !agentValues.includes('country'))
    pass('⛔ the agent’s payload carries NEITHER the definition NOR the value — absent, not blanked');
  else fail('withholding', JSON.stringify({ agentEntries, agentValues }).slice(0, 160));
  const writeRestricted = await agentApi('PATCH', `/conversations/${tid}/fields/country`, { value: 'Brazil' });
  const writeUnknown = await agentApi('PATCH', `/conversations/${tid}/fields/no_such_field`, { value: 'x' });
  if (writeRestricted.status === writeUnknown.status
      && JSON.stringify(writeRestricted.json) === JSON.stringify(writeUnknown.json))
    pass('⛔ the restricted write and the unknown-key write are INDISTINGUISHABLE — no oracle');
  else fail('no-oracle', `${writeRestricted.status} vs ${writeUnknown.status}`);
  const healed = await flag(false);
  if (healed.status === 200) pass('the fixture self-healed through the product (restricted flag lifted)');
  else fail('self-heal', `${healed.status}`);

  // ── 5: idempotence — the identical value twice, stored state unchanged ─────────────────────────
  const first = await agentApi('PATCH', `/conversations/${tid}/fields/psp`, { value: 'PayCord' });
  const second = await agentApi('PATCH', `/conversations/${tid}/fields/psp`, { value: 'PayCord' });
  const held = await agentApi('GET', `/conversations/${tid}/fields`);
  const psp = (held.json?.values ?? []).find((v) => v.fieldKey === 'psp');
  if (first.status === 200 && second.status === 200 && psp?.value === 'PayCord')
    pass('the identical value twice: both 200, one stored fact (idempotence)');
  else fail('idempotence', `${first.status}/${second.status} ${JSON.stringify(psp)}`);

  // ── 6: a formless ticket renders exactly as before ──────────────────────────────────────────────
  const conv2 = await adminApi('POST', '/conversations/initiate-email', {
    brandId: BRAND, playerId: PLAYER, subject: `w30 formless ${RUN}`, body: 'no form',
  });
  const tid2 = conv2.json?.id;
  await p2.goto(`${WEB}/tickets/${tid2}`, { waitUntil: 'networkidle', timeout: 30000 });
  await p2.waitForSelector('[data-testid="field-status"]', { timeout: 20000 });
  const rows = await p2.$$eval('[data-testid^="cf-"]', (els) => els.length);
  if (rows === 0) pass('a ticket with no form: the window is itself, zero field rows, zero gates');
  else fail('formless regression', `${rows} cf- rows`);

  // ── both themes, through the product control, restored after ───────────────────────────────────
  await p2.goto(`${WEB}/tickets/${tid}`, { waitUntil: 'networkidle', timeout: 30000 });
  await p2.waitForSelector('[data-testid="custom-fields"]', { timeout: 20000 });
  await p2.screenshot({ path: `${SHOTS}/w30-ticket-light.png` });
  await p.screenshot({ path: `${SHOTS}/w30-admin-light.png` });
  await p.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.click('[data-testid="theme-dark"]');
  // eslint-disable-next-line no-undef -- the predicate runs in the BROWSER, where document exists
  await p.waitForFunction(() => document.documentElement.classList.contains('dark'), undefined, { timeout: 8000 });
  await p.goto(`${WEB}/admin/fields`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="tab-fields"]', { timeout: 20000 });
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${SHOTS}/w30-admin-dark.png` });
  await p.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.click('[data-testid="theme-light"]');
  await p.waitForTimeout(1000);
  pass('both-theme screenshots taken through the product control, theme restored');

  if (errors.length === 0) pass('no uncaught page errors during the whole pass');
  else fail('page errors', errors.slice(0, 2).join(' | '));
  await ctx2.close().catch(() => {});
  await ctx.close().catch(() => {});
} catch (err) {
  fail('the pass could not run', err instanceof Error ? err.message : String(err));
  // The failing FRAME, kept: a click timeout names a selector, never a state — the frame does.
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    for (let i = 0; i < pages.length; i += 1) {
      await pages[i].screenshot({ path: `${SHOTS}/w30-FAIL-${i}.png` });
    }
  } catch {
    /* the fail-frame is best-effort — a dead browser must not mask the original failure */
  }
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW30 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
