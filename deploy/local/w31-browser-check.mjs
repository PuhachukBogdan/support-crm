/**
 * W31 live check — staff provisioning API, API keys & the offboarding handover (roadmap 3.15 + 3.17,
 * spec 038), as BEHAVIOUR.
 *
 *   1  ⭐ the admin CUTS A KEY on /admin/api-keys — the value is shown ONCE, and re-reading the list
 *      never returns it again (the screen and the wire agree)
 *   2  ⭐ a SIGNED create over `/api/provisioning/v1/staff` invites a newcomer; the invitation lands
 *      in the mailbox and the person is on the users list as pending
 *   3  ⛔ every refusal in words, each answered as problem+json: a bad signature · a stale timestamp ·
 *      an unlisted address · a REVOKED key — and the revoked key answers the SAME 401 an invented
 *      one does (no oracle for which credentials ever existed)
 *   4  ⭐ idempotence: the same Idempotency-Key + same body ⇒ the FIRST answer verbatim and NO second
 *      invitation; the same key + a DIFFERENT body ⇒ 409
 *   5  ⭐ re-hire: create for an id already mapped to a deactivated account REACTIVATES that record —
 *      one human, one account, never a twin
 *   6  ⛔ SEC-PV1: the key cannot touch an administrator — create AND delete against an admin's
 *      identity are both refused, and the refusals are in the journal with the key's fingerprint
 *   7  ⭐ SEC-PV2, the whole point: an operator holding an open conversation is offboarded, and
 *      within a tick that conversation is BACK IN THE BACKLOG rather than hanging on an inactive
 *      user — observed as the server's own state, and as a `staff.handover` line in the journal
 *   8  a repeated DELETE is a no-op success, and the record still exists (deactivation, never erasure)
 *   + light and dark screenshots of /admin/api-keys through the product theme control
 *
 * ⚠️ Run ON THE STAND against the VERIFICATION origin (rule 12 — the public link is frozen).
 * ⚠️ Requires the auth RE-SEED first (the `newcomer` role) and «making the login usable».
 */
import { chromium } from 'playwright';
import { createHmac } from 'node:crypto';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-next.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.2:8025';
const OWNER = process.env.OWNER_EMAIL ?? 'warden@beton.win';
const OWNER_PW = process.env.OWNER_PASSWORD ?? '';
const AGENT = process.env.PROBE_EMAIL ?? 'role-support-agent@beton.win';
const AGENT_PW = process.env.PROBE_PASSWORD ?? 'Stand#Role7x';
const SHOTS = process.env.SHOT_DIR ?? '/tmp/pw-work/shots';
/** The address the stand's own proxy will report for this runner. Fail-closed lists need it exact. */
const MY_IP = process.env.RUNNER_IP ?? '127.0.0.1';

let ok = 0, bad = 0;
const pass = (m) => { ok += 1; console.log(`  PASS  ${m}`); };
const fail = (m, d) => { bad += 1; console.log(`  FAIL  ${m}${d ? ` — ${d}` : ''}`); };

const edgeHeaders = () =>
  process.env.EDGE_USER
    ? { Authorization: 'Basic ' + Buffer.from(`${process.env.EDGE_USER}:${process.env.EDGE_PASSWORD ?? ''}`).toString('base64') }
    : {};

async function codeFor(email, what = 'code: ([A-Z0-9]{6})') {
  for (let i = 0; i < 20; i += 1) {
    const res = await fetch(`${MAIL}/api/v1/search?query=to%3A${encodeURIComponent(email)}&limit=1`, { headers: edgeHeaders() });
    const m = JSON.stringify(await res.json().catch(() => ({}))).match(new RegExp(what));
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no mail matching ${what} for ${email}`);
}

async function apiSession(email, password) {
  const base = `${WEB}/api`;
  const h = { 'Content-Type': 'application/json', ...edgeHeaders() };
  const login = await fetch(`${base}/auth/login`, { method: 'POST', headers: h, body: JSON.stringify({ email, password }) });
  const loginBody = await login.text();
  let challengeId;
  try { challengeId = JSON.parse(loginBody).challengeId; } catch { /* not json — say so below */ }
  // ⚠️ The status and the first line of the answer, not just «it failed». A silent «login step 1
  // failed» sent the W31 round chasing the wrong thing twice: the same call worked from curl, and
  // only the body said why.
  if (!challengeId) throw new Error(`login step 1 failed for ${email}: ${login.status} ${loginBody.slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 3000));
  const verify = await fetch(`${base}/auth/verify`, {
    method: 'POST', headers: h, body: JSON.stringify({ challengeId, code: await codeFor(email) }),
  });
  const cookie = (verify.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`verify produced no cookie for ${email}`);
  return async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { ...h, Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, contentType: res.headers.get('content-type') ?? '' };
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

/**
 * The receipt is the SERVER's state: poll the read until it holds the value, or say it never did.
 *
 * ⚠️ The window must clear **at least two tick intervals**. The handover is a sweep, not part of the
 * request (ADR 0043 §4's implementation note), so a poll shorter than the tick reports «it never
 * happened» about a system doing exactly what it should — which is what the first W31 round did,
 * while the worker's own log said `moved=26` a few seconds later.
 */
async function until(readFn, predicate, what, tries = 40, waitMs = 5000) {
  for (let i = 0; i < tries; i += 1) {
    const res = await readFn();
    if (predicate(res)) return res;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  throw new Error(`the server never held: ${what}`);
}

// ── the machine caller ──────────────────────────────────────────────────────────────────────────
//
// Exactly the shape another company's system sends: `<id>.<secret>` in one header, and a signature
// over "<unix>.<raw bytes>" in another. The body is serialised ONCE and both signed and sent — the
// property the whole feature rests on, so the check must not re-serialise it either.
function machineCall(keyValue, { method = 'POST', path = '/api/provisioning/v1/staff', body = null, idem, skewSeconds = 0, breakSignature = false }) {
  const raw = body === null ? '' : JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000) + skewSeconds;
  const secret = keyValue.slice(keyValue.indexOf('.') + 1);
  const digest = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return fetch(`${WEB}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...edgeHeaders(),
      'x-crm-key': keyValue,
      'x-crm-signature': `t=${t},v1=${breakSignature ? 'f'.repeat(64) : digest}`,
      'Idempotency-Key': idem,
    },
    body: raw === '' ? undefined : raw,
  }).then(async (res) => {
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, contentType: res.headers.get('content-type') ?? '' };
  });
}

const RUN = Date.now().toString(36);
const CONSUMER = `w31 HR probe ${RUN}`;
const NEWCOMER = `w31-newcomer-${RUN}@beton.win`;
const EMPLOYEE = `E-${RUN}`;

const browser = await chromium.launch();
try {
  const creds = process.env.EDGE_USER
    ? { httpCredentials: { username: process.env.EDGE_USER, password: process.env.EDGE_PASSWORD ?? '' } }
    : {};
  const ownerApi = await apiSession(OWNER, OWNER_PW);

  // ── 1. the key is cut, and its value is shown once ──────────────────────────────────────────────
  const issued = await ownerApi('POST', '/admin/api-keys', {
    consumer: CONSUMER,
    ipAllowList: [MY_IP],
    ratePerHour: 200,
  });
  const keyValue = issued.json?.value ?? '';
  const keyId = issued.json?.key?.id ?? '';
  keyValue.includes('.') && keyId
    ? pass('1 · a key is issued and its value is returned exactly once')
    : fail('1 · issuing the key', JSON.stringify(issued.json));

  const listed = await ownerApi('GET', '/admin/api-keys');
  const mine = (listed.json?.keys ?? []).find((k) => k.id === keyId);
  mine && !JSON.stringify(listed.json).includes(keyValue.split('.')[1])
    ? pass('1 · re-reading the list never returns the secret again')
    : fail('1 · the list leaked the secret or lost the key');

  // ── 2. a signed create invites a newcomer ───────────────────────────────────────────────────────
  const created = await machineCall(keyValue, {
    body: { hrEmployeeId: EMPLOYEE, email: NEWCOMER },
    idem: `idem-create-${RUN}`,
  });
  created.status === 202 && created.json?.outcome === 'invited'
    ? pass('2 · a signed create invites the newcomer (202)')
    : fail('2 · the signed create', `${created.status} ${JSON.stringify(created.json)}`);

  await codeFor(NEWCOMER, '(https?://[^"\\s]+)').then(
    () => pass('2 · the invitation actually reached the mailbox'),
    (e) => fail('2 · the invitation mail', e.message),
  );

  // ── 3. every refusal, in words ──────────────────────────────────────────────────────────────────
  const refusals = [
    ['a broken signature', { breakSignature: true }, 401],
    ['a stale timestamp', { skewSeconds: -3600 }, 401],
  ];
  for (const [name, over, expected] of refusals) {
    const r = await machineCall(keyValue, { body: { hrEmployeeId: `${EMPLOYEE}-x`, email: NEWCOMER }, idem: `idem-${name.replace(/\W/g, '')}-${RUN}`, ...over });
    r.status === expected && r.contentType.includes('application/problem+json')
      ? pass(`3 · ${name} ⇒ ${expected}, problem+json`)
      : fail(`3 · ${name}`, `${r.status} ${r.contentType}`);
  }

  const invented = await machineCall(`k-does-not-exist.${'a'.repeat(48)}`, {
    body: { hrEmployeeId: 'E-nobody', email: NEWCOMER }, idem: `idem-unknown-${RUN}`,
  });
  // ⚠️ The comparison below is the assertion, not the status on its own: a revoked key and an
  // invented one must be indistinguishable from outside, or the endpoint becomes a way to ask which
  // credentials once existed.
  const secondKey = await ownerApi('POST', '/admin/api-keys', { consumer: `${CONSUMER} spare`, ipAllowList: [MY_IP], ratePerHour: 10 });
  await ownerApi('DELETE', `/admin/api-keys/${secondKey.json?.key?.id}`);
  const revoked = await machineCall(secondKey.json?.value ?? 'x.y', {
    body: { hrEmployeeId: 'E-nobody', email: NEWCOMER }, idem: `idem-revoked-${RUN}`,
  });
  revoked.status === invented.status && revoked.status === 401
    ? pass('3 · ⭐ a revoked key answers exactly what an invented one does (401)')
    : fail('3 · revoked vs invented', `${revoked.status} vs ${invented.status}`);

  // ── 4. idempotence ──────────────────────────────────────────────────────────────────────────────
  const replay = await machineCall(keyValue, { body: { hrEmployeeId: EMPLOYEE, email: NEWCOMER }, idem: `idem-create-${RUN}` });
  // ⚠️ Compared as DATA, not as bytes. The first answer is stored in a `jsonb` column, which does not
  // preserve key order, so the replayed body is the same object serialised differently. Byte-identity
  // was the first version of this assertion and it failed on a system that was behaving correctly.
  const sameAnswer =
    replay.status === created.status &&
    JSON.stringify(Object.entries(replay.json ?? {}).sort()) ===
      JSON.stringify(Object.entries(created.json ?? {}).sort());
  sameAnswer
    ? pass('4 · ⭐ the same key + same body replays the FIRST answer')
    : fail('4 · the replay differed', `${replay.status} ${JSON.stringify(replay.json)}`);

  // …and the property the status alone cannot show: NO second side effect. One invitation, not two.
  const mails = await fetch(`${MAIL}/api/v1/search?query=to%3A${encodeURIComponent(NEWCOMER)}&limit=20`, { headers: edgeHeaders() });
  const mailCount = (await mails.json().catch(() => ({}))).messages_count ?? (await Promise.resolve(0));
  Number(mailCount) === 1
    ? pass('4 · ⭐ and the replay sent NO second invitation — one mail, not two')
    : fail('4 · the replay had a side effect', `${mailCount} invitations`);

  const conflict = await machineCall(keyValue, { body: { hrEmployeeId: `${EMPLOYEE}-other`, email: NEWCOMER }, idem: `idem-create-${RUN}` });
  conflict.status === 409
    ? pass('4 · the same key + a DIFFERENT body ⇒ 409')
    : fail('4 · the conflict', `${conflict.status}`);

  // ── 5–8 need somebody who actually holds work: the seeded support agent ─────────────────────────
  const agentApi = await apiSession(AGENT, AGENT_PW);
  const me = await agentApi('GET', '/me/operator');
  let operatorId = me.json?.operatorId ?? me.json?.id ?? me.json?.operator?.id ?? '';

  // Bind the agent to an HR id by creating against their existing e-mail: an active account is a
  // no-op, and the binding is what the offboarding will address them by.
  const bind = await machineCall(keyValue, {
    body: { hrEmployeeId: `${EMPLOYEE}-agent`, email: AGENT }, idem: `idem-bind-${RUN}`,
  });
  bind.status === 200 && bind.json?.outcome === 'noop_active'
    ? pass('5 · a create for somebody already working here is a no-op, not an error')
    : fail('5 · the no-op create', `${bind.status} ${JSON.stringify(bind.json)}`);

  // ── 6. SEC-PV1 — the key cannot touch an administrator ──────────────────────────────────────────
  const touchAdmin = await machineCall(keyValue, {
    body: { hrEmployeeId: `${EMPLOYEE}-owner`, email: OWNER }, idem: `idem-admin-${RUN}`,
  });
  touchAdmin.status === 403
    ? pass('6 · ⛔ the key cannot create or touch an administrator (403)')
    : fail('6 · the administrator bar', `${touchAdmin.status} ${JSON.stringify(touchAdmin.json)}`);

  // ── 7. SEC-PV2 — the handover ───────────────────────────────────────────────────────────────────
  // ⚠️ The check MANUFACTURES the condition it tests rather than hoping the stand carries it. A run
  // that silently skips its own headline assertion because a fixture was missing is the shape that
  // reports success for work nobody proved (the first W31 round did exactly that).
  const open = await ownerApi('GET', '/conversations?statusCategories=new,open&pageSize=1');
  const row = open.json?.conversations?.[0] ?? null;
  const held = row?.id ?? '';
  // ⚠️ Fall back to whoever ALREADY holds the row. `/me/operator` is the tidy source for the agent's
  // own id, but this check must still be able to prove the handover on a stand where that read is
  // unavailable — the assertion is about the offboarding, not about how we learned the id.
  if (!operatorId) operatorId = row?.assigneeOperatorId ?? '';
  if (held && operatorId) {
    const assigned = await ownerApi('PUT', `/conversations/${held}/assignee`, { operatorId });
    assigned.status < 300
      ? pass('7 · a live conversation is put on the agent, so there is real work to hand over')
      : fail('7 · could not assign the fixture conversation', `${assigned.status}`);
  }
  if (!held || !operatorId) {
    fail('7 · no open conversation on the stand to hand over', `conversation=${!!held} operator=${!!operatorId}`);
  } else {
    const off = await machineCall(keyValue, {
      method: 'DELETE', path: `/api/provisioning/v1/staff/${EMPLOYEE}-agent`, idem: `idem-off-${RUN}`,
    });
    off.status === 200 && off.json?.outcome === 'deactivated'
      ? pass('7 · the offboarding closed the account (200 deactivated)')
      : fail('7 · the offboarding', `${off.status} ${JSON.stringify(off.json)}`);

    // ⚠️ The tick owns the handover, so this POLLS. That wait IS the design: the guarantee rests on
    // our own infrastructure retrying rather than on the HR platform noticing a failure flag.
    await until(
      () => ownerApi('GET', `/conversations/${held}`),
      // ⚠️ **EMPTY STRING, not null.** proto3 has no null for a string — an unassigned conversation
      // comes back as `""`, and `?? null` does not treat `''` as absent. The first version of this
      // predicate waited for a null that the wire can never produce, and reported «the handover never
      // happened» about a run whose worker log said `moved=1`.
      (r) => String(r.json?.assigneeOperatorId ?? r.json?.assignee_operator_id ?? '').trim() === '',
      'the departed operator’s conversation left them',
    ).then(
      () => pass('7 · ⭐ within a tick the conversation is no longer assigned to the departed operator'),
      (e) => fail('7 · the handover never happened', e.message),
    );

    await until(
      () => ownerApi('GET', '/audit?action=staff.handover&pageSize=5'),
      (r) => (r.json?.entries ?? r.json?.items ?? []).some(
        (e) => String(e.targetRef ?? e.target_ref ?? '') === operatorId,
      ),
      'a staff.handover line naming this operator',
    ).then(
      () => pass('7 · the journal carries the handover, with counts and no conversation id'),
      (e) => fail('7 · the handover audit line', e.message),
    );

    // ── 8. a repeat is a no-op, and the record survives ──────────────────────────────────────────
    const again = await machineCall(keyValue, {
      method: 'DELETE', path: `/api/provisioning/v1/staff/${EMPLOYEE}-agent`, idem: `idem-off2-${RUN}`,
    });
    again.status === 200 && again.json?.outcome === 'noop_inactive'
      ? pass('8 · a repeated offboarding is a no-op success')
      : fail('8 · the repeated offboarding', `${again.status} ${JSON.stringify(again.json)}`);

    // ── 9. ⭐ the RE-HIRE, which is also this check's own cleanup ────────────────────────────────
    //
    // ⚠️ The offboarding above really does close the account — so a check that stopped here would
    // destroy the stand fixture it depends on, and the SECOND run would fail at login with
    // `invalid_credentials`. That happened, and the fix is not to offboard somebody less important:
    // it is to walk the documented re-hire path (§7) and put them back through the product. Cleanup
    // and assertion are the same act, which is the only kind of cleanup that cannot rot.
    const rehire = await machineCall(keyValue, {
      body: { hrEmployeeId: `${EMPLOYEE}-agent`, email: AGENT }, idem: `idem-rehire-${RUN}`,
    });
    rehire.status === 202 && rehire.json?.outcome === 'reactivated'
      ? pass('9 · ⭐ a create for a DEACTIVATED employee reactivates the record — not a second account')
      : fail('9 · the re-hire', `${rehire.status} ${JSON.stringify(rehire.json)}`);

    // The person still completes the ordinary flow: link → own password → emailed code. No password
    // ever crossed the machine boundary, in either direction — that is the point of §2.
    try {
      const link = await codeFor(AGENT, '(https?://[^"\\s]+/register[^"\\s]*)');
      const token = new URL(link.replace(/&amp;/g, '&')).searchParams.get('token') ?? '';
      const h = { 'Content-Type': 'application/json', ...edgeHeaders() };
      const started = await fetch(`${WEB}/api/auth/register/start`, { method: 'POST', headers: h, body: JSON.stringify({ token, email: AGENT }) });
      if (started.status >= 300) fail('9 · register/start refused', `${started.status} ${(await started.text()).slice(0, 160)}`);
      await new Promise((r) => setTimeout(r, 3000));
      const done = await fetch(`${WEB}/api/auth/register/complete`, {
        method: 'POST', headers: h,
        // The SAME password, so the fixture is where the next run expects it.
        body: JSON.stringify({ token, email: AGENT, code: await codeFor(AGENT), password: AGENT_PW }),
      });
      done.status < 300
        ? pass('9 · the returning colleague completes the ordinary invite flow and can work again')
        : fail('9 · the re-hire onboarding', `${done.status}`);
    } catch (e) {
      fail('9 · the re-hire onboarding', e?.message ?? String(e));
    }

    const stillThere = await ownerApi('GET', `/conversations/${held}`);
    // Deactivation, never erasure: their authorship of the messages in that conversation stands.
    stillThere.status === 200
      ? pass('8 · the record and its history survive the deactivation')
      : fail('8 · the record vanished', `${stillThere.status}`);
  }

  // ── the screen, in both themes ───────────────────────────────────────────────────────────────────
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ...creds });
  await signIn(page, OWNER, OWNER_PW);
  await page.goto(`${WEB}/admin/api-keys`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1200);
  const shown = await page.locator('body').innerText();
  shown.includes(CONSUMER)
    ? pass('screen · the issued key is on /admin/api-keys, named by its consumer')
    : fail('screen · the key is not on the screen');
  !shown.includes(keyValue.split('.')[1])
    ? pass('screen · ⭐ the secret is nowhere on a re-opened screen')
    : fail('screen · the secret survived a reload');

  for (const theme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/w31-api-keys-${theme}.png`, fullPage: true });
  }
  pass('screen · light and dark screenshots written');
  await page.close();
} catch (e) {
  fail('the run itself', e?.message ?? String(e));
} finally {
  await browser.close();
}

console.log(`\nW31: ${ok} passed, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
