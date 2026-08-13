/**
 * W35 live check — player notes as BEHAVIOUR (R35 · U17, spec 040).
 *
 *   A  ⭐ the FIVE-ROLE table, on the wire: the attached AM reads and writes; an UNATTACHED AM, a
 *      team lead and a line agent are refused by the SERVER; an administrator reads with no attachment
 *   B  ⭐ the detector round trip: a phone number is answered with a WARNING and nothing is stored;
 *      acknowledged, it stores AND writes exactly one audit entry — with no digit of the number in it
 *   C  ⛔ there is no verb to change or remove a note — asserted against the running edge
 *   D  a retried add is ONE row (idempotence by clientRef, never by body)
 *   E  ⭐⭐ THE BLOCK'S OWN REQUIREMENT: after a handover the SUCCESSOR reads the previous manager's
 *      notes, signed with THEIR name — and the previous manager is refused from that moment
 *   F  the screen: add a note, meet the warning, add anyway; both surfaces, both themes, screenshots
 *
 * ⚠️ The POSITIVE CONTROL runs first, everywhere. «It was refused» is satisfied by a route that never
 * existed, a login that failed for the wrong reason, and a player that is not there.
 *
 * ⚠️ Every assertion about the audit trail is a DELTA. The store is append-only and other checks write
 * to it, so an absolute count means nothing.
 *
 * ⚠️ Run ON THE STAND against the VERIFICATION origin (rule 12 — the public link is frozen).
 */
import { chromium } from 'playwright';
import { assertNoRenderStorm } from './lib/no-render-storm.mjs';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-next.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.2:8025';
const ROLE_PW = process.env.ROLE_PASSWORD ?? 'Stand#Role7x';
const AM = process.env.AM_EMAIL ?? 'role-am@beton.win';
const AM2 = process.env.AM2_EMAIL ?? 'role-shift-am@beton.win';
const LEAD = process.env.LEAD_EMAIL ?? 'role-teamlead@beton.win';
const AGENT = process.env.AGENT_EMAIL ?? 'role-support-agent@beton.win';
const ADMIN = process.env.ADMIN_EMAIL ?? 'admin@example.test';
const ADMIN_PW = process.env.ADMIN_PASSWORD ?? '';
const PLAYER = process.env.PLAYER_ID ?? 'seed-player-001';
const BRAND = process.env.BRAND_ID ?? 'seed-brand-0000-0000-000000000001';
const SHOTS = process.env.SHOT_DIR ?? '/tmp/pw-work/shots';

let ok = 0;
let bad = 0;
const pass = (m) => { ok += 1; console.log(`  PASS  ${m}`); };
const fail = (m, d) => { bad += 1; console.log(`  FAIL  ${m}${d ? ` — ${d}` : ''}`); };
const note = (m) => console.log(`  ⓘ  ${m}`);

const edgeHeaders = () =>
  process.env.EDGE_USER
    ? {
        Authorization:
          'Basic ' +
          Buffer.from(`${process.env.EDGE_USER}:${process.env.EDGE_PASSWORD ?? ''}`).toString('base64'),
      }
    : {};

async function codeFor(email) {
  for (let i = 0; i < 20; i += 1) {
    const res = await fetch(`${MAIL}/api/v1/search?query=to%3A${encodeURIComponent(email)}&limit=1`, {
      headers: edgeHeaders(),
    });
    const m = JSON.stringify(await res.json().catch(() => ({}))).match(/code: ([A-Z0-9]{6})/);
    if (m) return m[1];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no login code for ${email}`);
}

async function apiSession(email, password) {
  const base = `${WEB}/api`;
  const h = { 'Content-Type': 'application/json', ...edgeHeaders() };
  const login = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ email, password }),
  });
  const { challengeId } = await login.json().catch(() => ({}));
  if (!challengeId) throw new Error(`login step 1 failed for ${email}: ${login.status}`);
  await new Promise((r) => setTimeout(r, 3000));
  const verify = await fetch(`${base}/auth/verify`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ challengeId, code: await codeFor(email) }),
  });
  const cookie = (verify.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`verify produced no cookie for ${email}`);
  const call = async (method, path, payload) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...h, Cookie: cookie },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };
  call.cookie = cookie;
  return call;
}

async function signIn(p, email, password) {
  await p.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.fill('input[type="email"]', email);
  await p.fill('input[type="password"]', password);
  await p.click('button[type="submit"]');
  await p.waitForTimeout(2500);
  await p.fill(
    'input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]',
    await codeFor(email),
  );
  await p.click('button[type="submit"]');
  await p.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
}

const notesPath = `/players/${PLAYER}/notes?brandId=${encodeURIComponent(BRAND)}`;
const listNotes = async (api) => api('GET', notesPath);
const addNote = async (api, body, extra = {}) =>
  api('POST', `/players/${PLAYER}/notes`, {
    brandId: BRAND,
    body,
    clientRef: `w35-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ...extra,
  });

/** How many `player.note_flagged` entries exist right now. The DELTA is what any claim rests on. */
async function flaggedCount(api) {
  const res = await api('GET', '/audit?action=player.note_flagged&pageSize=50');
  const entries = res.json?.entries ?? res.json?.items ?? [];
  return { n: entries.length, entries, status: res.status };
}

const RUN = Date.now().toString(36);
const PHONE = '+34 600 123 456';
const browser = await chromium.launch();

try {
  // ═══ sessions ══════════════════════════════════════════════════════════════════════════════════
  const admin = await apiSession(ADMIN, ADMIN_PW);
  const am = await apiSession(AM, ROLE_PW);
  const am2 = await apiSession(AM2, ROLE_PW);
  const lead = await apiSession(LEAD, ROLE_PW);
  const agent = await apiSession(AGENT, ROLE_PW);

  const meAm = await am('GET', '/auth/me');
  const meAm2 = await am2('GET', '/auth/me');
  const amId = meAm.json?.userId ?? meAm.json?.user?.id ?? '';
  const am2Id = meAm2.json?.userId ?? meAm2.json?.user?.id ?? '';
  if (!amId || !am2Id) throw new Error('could not resolve the two managers’ auth ids');

  /**
   * The fixture, established THROUGH THE PRODUCT: the administrator attaches the first manager.
   *
   * ⚠️ Never by writing the row. Feature 024's three live defects were all one class — *the fixture is
   * not what the script believes it is* — and here the attachment IS the access rule under test.
   * ⓘ `am` deliberately does not hold `users.player.assign` on this stand, so the administrator does it.
   */
  await admin('DELETE', `/players/${BRAND}/${PLAYER}/assignment`);
  const attached = await admin('POST', `/players/${BRAND}/${PLAYER}/assignment`, { amAuthUserId: amId });
  attached.status < 300
    ? pass('fixture · the administrator attached the manager through the product’s own path')
    : fail('fixture · attaching the manager', `${attached.status} ${JSON.stringify(attached.json)}`);

  // ═══ A · the five-role table, on the WIRE ══════════════════════════════════════════════════════
  const wrote = await addNote(am, `w35 ordinary ${RUN} — играет по выходным`);
  wrote.status === 200 && wrote.json?.outcome === 'stored'
    ? pass('A1 · ⭐ POSITIVE CONTROL: the attached manager stores a note')
    : fail('A1 · the attached manager could not store a note', `${wrote.status} ${JSON.stringify(wrote.json)}`);

  const readBack = await listNotes(am);
  const mine = (readBack.json?.notes ?? []).find((n) => n.body.includes(`w35 ordinary ${RUN}`));
  mine
    ? pass('A2 · …and reads it back')
    : fail('A2 · the note did not come back', `${readBack.status} ${JSON.stringify(readBack.json).slice(0, 200)}`);
  mine?.authorDisplayName || mine?.authorRef
    ? pass(`A3 · it is SIGNED (author: ${mine?.authorDisplayName || mine?.authorRef})`)
    : fail('A3 · the note came back unsigned');

  /**
   * ⭐ A3b — the NAME resolves where the product holds one, and that needs its own assertion.
   *
   * ⚠️ On this stand every `role-*` account has a NULL `display_name` in both `auth.User` and
   * `users.Operator` — they were created by invite, and `EnsureOwnOperator` deliberately takes no name
   * (the authoritative one is auth's, collected at registration; HR provisioning at 3.15 supplies it).
   * So a note written by the probe manager is signed with their REFERENCE, which is the documented
   * fallback and NOT a defect — but a check that stopped at A3 would accept a UUID as a name for ever.
   *
   * The seeded notes are the positive control: their authors DO have names, so this proves the
   * resolution path works rather than that the fallback does.
   */
  const named = (readBack.json?.notes ?? []).find((n) => (n.authorDisplayName ?? '') !== '');
  named
    ? pass(`A3b · ⭐ an author with a profile name renders the NAME (${named.authorDisplayName})`)
    : fail('A3b · no note resolved an author NAME — the resolution path may be dead');
  note(
    'the probe manager signs with a REFERENCE: `role-*` accounts hold no display name on this stand ' +
      '(invited, and the name arrives with HR provisioning) — the documented fallback, not a gap in W35',
  );

  for (const [label, api] of [
    ['a line agent', agent],
    ['a team lead', lead],
  ]) {
    const res = await listNotes(api);
    res.status === 403
      ? pass(`A4 · ⛔ ${label} is refused BY THE SERVER (403), not merely shown nothing`)
      : fail(`A4 · ${label} read the notes`, `${res.status} ${JSON.stringify(res.json).slice(0, 160)}`);
    const body = JSON.stringify(res.json ?? '');
    !body.includes(RUN) && !/\d+\s*notes?/i.test(body)
      ? pass(`A4 · …and the refusal says nothing about the notes (${label})`)
      : fail(`A4 · the refusal leaked something (${label})`, body.slice(0, 160));
  }

  const unattached = await listNotes(am2);
  unattached.status === 403
    ? pass('A5 · ⭐ an UNATTACHED manager is refused — the tier narrows PER RECORD, not per role')
    : fail('A5 · an unattached manager read the notes', `${unattached.status}`);

  const adminRead = await listNotes(admin);
  adminRead.status === 200
    ? pass('A6 · an administrator reads with no attachment (the administrative clearance)')
    : fail('A6 · the administrator was refused', `${adminRead.status}`);

  const leadWrite = await addNote(lead, 'w35 lead must not write');
  leadWrite.status === 403
    ? pass('A7 · ⛔ a team lead cannot WRITE either — reading and writing are separate rights')
    : fail('A7 · a team lead wrote a note', `${leadWrite.status}`);

  // ═══ B · the detector round trip ═══════════════════════════════════════════════════════════════
  const before = await flaggedCount(admin);
  before.status === 200
    ? note(`the trail currently holds ${before.n} flagged-note entries (the DELTA is what matters)`)
    : fail('B0 · the audit read did not answer', `${before.status}`);

  const beforeCount = (await listNotes(am)).json?.notes?.length ?? 0;
  const warnRef = `w35-warn-${RUN}`;
  const warned = await am('POST', `/players/${PLAYER}/notes`, {
    brandId: BRAND,
    body: `w35 звонить на ${PHONE} ${RUN}`,
    clientRef: warnRef,
  });
  warned.status === 200 && warned.json?.outcome === 'needs_acknowledgement'
    ? pass(`B1 · ⭐ a phone number is answered with a WARNING (kinds: ${(warned.json?.patternKinds ?? []).join(',')})`)
    : fail('B1 · the contact-shaped body was not warned about', `${warned.status} ${JSON.stringify(warned.json)}`);

  const afterWarn = (await listNotes(am)).json?.notes?.length ?? -1;
  afterWarn === beforeCount
    ? pass('B2 · …and NOTHING was stored — the count is unchanged')
    : fail('B2 · the warned body was stored anyway', `${beforeCount} → ${afterWarn}`);

  const midway = await flaggedCount(admin);
  midway.n === before.n
    ? pass('B3 · a heeded warning writes NO audit entry (a non-event is not recorded)')
    : fail('B3 · the warning alone wrote an entry', `${before.n} → ${midway.n}`);

  const acked = await am('POST', `/players/${PLAYER}/notes`, {
    brandId: BRAND,
    body: `w35 звонить на ${PHONE} ${RUN}`,
    acknowledged: true,
    clientRef: warnRef,
  });
  acked.status === 200 && acked.json?.outcome === 'stored'
    ? pass('B4 · ⭐ acknowledged, it STORES — the warning is not a refusal (U17)')
    : fail('B4 · the acknowledged body was not stored', `${acked.status} ${JSON.stringify(acked.json)}`);
  (acked.json?.note?.patternKinds ?? []).includes('phone')
    ? pass('B5 · the stored row remembers what its author was warned about')
    : fail('B5 · the stored row lost the detector verdict', JSON.stringify(acked.json?.note));

  const after = await flaggedCount(admin);
  after.n - before.n === 1
    ? pass('B6 · exactly ONE audit entry was written (delta, not absolute)')
    : fail('B6 · the flagged entry count moved wrongly', `${before.n} → ${after.n}`);

  const fresh = JSON.stringify(after.entries.filter((e) => !before.entries.some((b) => b.id === e.id)));
  !fresh.includes('600') && !fresh.includes('600123456') && !fresh.includes('звонить')
    ? pass('B7 · ⭐ the entry carries NO digit of the number and no fragment of the note')
    : fail('B7 · the audit entry leaked part of the note', fresh.slice(0, 200));
  fresh.includes('phone')
    ? pass('B8 · …while it DOES carry the kind — so B7 is not passing on an empty entry')
    : fail('B8 · the entry does not name the kind', fresh.slice(0, 200));

  const plainRef = `w35-plain-${RUN}`;
  await am('POST', `/players/${PLAYER}/notes`, {
    brandId: BRAND,
    body: `w35 обычная заметка ${RUN}`,
    clientRef: plainRef,
  });
  const afterPlain = await flaggedCount(admin);
  afterPlain.n === after.n
    ? pass('B9 · an ordinary note writes no entry at all — the row is its own record')
    : fail('B9 · an ordinary note wrote an audit entry', `${after.n} → ${afterPlain.n}`);

  // ═══ C · there is no verb to change or remove one ══════════════════════════════════════════════
  const target = (await listNotes(am)).json?.notes?.[0]?.id ?? '';
  for (const method of ['PATCH', 'PUT', 'DELETE']) {
    const res = await am(method, `/players/${PLAYER}/notes/${target}`, { body: 'rewritten' });
    res.status === 404 || res.status === 405
      ? pass(`C · ⛔ ${method} on a note does not exist (${res.status})`)
      : fail(`C · ${method} on a note was answered`, `${res.status} ${JSON.stringify(res.json).slice(0, 120)}`);
  }
  const stillThere = (await listNotes(am)).json?.notes?.find((n) => n.id === target);
  stillThere && !stillThere.body.includes('rewritten')
    ? pass('C · …and the note is unchanged after all three attempts')
    : fail('C · a note changed under an attempt that should not exist');

  // ═══ D · a retry is one row ════════════════════════════════════════════════════════════════════
  const dRef = `w35-retry-${RUN}`;
  const d1 = await am('POST', `/players/${PLAYER}/notes`, { brandId: BRAND, body: `w35 retry ${RUN}`, clientRef: dRef });
  const d2 = await am('POST', `/players/${PLAYER}/notes`, { brandId: BRAND, body: `w35 retry ${RUN}`, clientRef: dRef });
  const retries = (await listNotes(am)).json?.notes?.filter((n) => n.body === `w35 retry ${RUN}`) ?? [];
  retries.length === 1 && d2.json?.replayed === true && d1.json?.note?.id === d2.json?.note?.id
    ? pass('D · the same clientRef twice → ONE row, and the second call SAYS it was a replay')
    : fail('D · the retry was not idempotent', `${retries.length} rows, replayed=${d2.json?.replayed}`);

  // ═══ E · the handover — the block's own requirement ═════════════════════════════════════════════
  await admin('DELETE', `/players/${BRAND}/${PLAYER}/assignment`);
  const handed = await admin('POST', `/players/${BRAND}/${PLAYER}/assignment`, { amAuthUserId: am2Id });
  handed.status < 300
    ? pass('E1 · the portfolio is handed to the successor (through the product)')
    : fail('E1 · the handover', `${handed.status} ${JSON.stringify(handed.json)}`);

  const successor = await listNotes(am2);
  const inherited = (successor.json?.notes ?? []).find((n) => n.body.includes(`w35 ordinary ${RUN}`));
  successor.status === 200 && inherited
    ? pass('E2 · ⭐⭐ the SUCCESSOR reads the previous manager’s notes')
    : fail('E2 · the successor cannot read the inherited notes', `${successor.status}`);
  inherited && (inherited.authorDisplayName || inherited.authorRef) && inherited.authorRef !== am2Id
    ? pass(`E3 · ⭐⭐ …and each one is signed by WHOEVER WROTE IT (${inherited.authorDisplayName || inherited.authorRef}), not by the reader`)
    : fail('E3 · the inherited note is not attributed to its real author', JSON.stringify(inherited));

  const formerly = await listNotes(am);
  formerly.status === 403
    ? pass('E4 · ⛔ the previous manager is refused from that moment — the SAME session, no re-login')
    : fail('E4 · the detached manager still reads the notes', `${formerly.status}`);

  // Put it back, so a second consecutive run starts from the same fixture.
  await admin('DELETE', `/players/${BRAND}/${PLAYER}/assignment`);
  await admin('POST', `/players/${BRAND}/${PLAYER}/assignment`, { amAuthUserId: amId });

  // ═══ F · the screen ════════════════════════════════════════════════════════════════════════════
  const creds = process.env.EDGE_USER
    ? { httpCredentials: { username: process.env.EDGE_USER, password: process.env.EDGE_PASSWORD ?? '' } }
    : {};
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 }, ...creds });
  const errors = [];
  ctx.on('weberror', (e) => errors.push(e.error().message));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));

  await signIn(p, AM, ROLE_PW);

  // ── the full player page ──────────────────────────────────────────────────────────────────────
  /**
   * ⚠️ **F1 asserts the READ, not the presence of a section — and that correction came from a real
   * miss.** The area renders in its loading AND its error state, and a stored note is prepended from the
   * POST response, so «the area is there» and «a note appears» were both true while every notes read was
   * answering 400 (the browser sends `pageSize`; the route refused it). The positive control has to be the
   * page's OWN request coming back 200.
   */
  const pageRead = p
    .waitForResponse(
      (r) => r.url().includes(`/players/${PLAYER}/notes`) && r.request().method() === 'GET',
      { timeout: 25000 },
    )
    .catch(() => null);
  await p.goto(`${WEB}/players/${BRAND}/${PLAYER}`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="player-notes"]', { timeout: 20000 });
  const readRes = await pageRead;
  readRes && readRes.status() === 200
    ? pass(`F1 · ⭐ the page's OWN notes read answers 200 (${readRes.url().split('/api')[1]})`)
    : fail('F1 · the page’s notes read did not succeed', `status=${readRes?.status() ?? 'none'} ${readRes?.url() ?? ''}`);
  await p.waitForSelector('[data-testid="player-notes-list"] [data-testid="player-note"]', {
    timeout: 20000,
  });
  pass('F1b · …and the seeded notes are on the customer page');

  const rowsBefore = await p.$$eval('[data-testid="player-note"]', (els) => els.length);
  await p.fill('[data-testid="player-notes-draft"]', `w35 через экран ${RUN}`);
  await p.click('[data-testid="player-notes-add"]');
  await p.waitForFunction(
    (n) => document.querySelectorAll('[data-testid="player-note"]').length > n,
    rowsBefore,
    { timeout: 15000 },
  );
  pass('F2 · a note added on the screen appears immediately');

  const signature = await p.$eval('[data-testid="player-note-author"]', (el) => el.textContent?.trim() ?? '');
  signature.length > 0
    ? pass(`F3 · the row shows its author (${signature})`)
    : fail('F3 · the row has no visible author');

  const draftAfter = await p.inputValue('[data-testid="player-notes-draft"]');
  draftAfter === ''
    ? pass('F4 · the box is cleared once the note is stored')
    : fail('F4 · the box kept the text after a successful add', draftAfter);

  // ── the warning, on the screen ─────────────────────────────────────────────────────────────────
  await p.fill('[data-testid="player-notes-draft"]', `w35 экран, звонить на ${PHONE} ${RUN}`);
  await p.click('[data-testid="player-notes-add"]');
  await p.waitForSelector('[data-testid="player-notes-warning"]', { timeout: 15000 });
  pass('F5 · ⭐ the warning appears on the screen, at entry');
  const kept = await p.inputValue('[data-testid="player-notes-draft"]');
  kept.includes(PHONE)
    ? pass('F6 · ⭐ the author’s text is STILL IN THE BOX — the one moment it must not be lost')
    : fail('F6 · the warning cost the author their text', kept);

  await p.screenshot({ path: `${SHOTS}/w35-player-page-warning-light.png`, fullPage: true });

  await p.click('[data-testid="player-notes-acknowledge"]');
  await p.waitForFunction(
    () => !document.querySelector('[data-testid="player-notes-warning"]'),
    undefined,
    { timeout: 15000 },
  );
  const flagged = await p.$$eval('[data-testid="player-note-flag"]', (els) => els.length);
  flagged > 0
    ? pass('F7 · “Add anyway” stores it, and the row carries a quiet mark')
    : fail('F7 · the acknowledged note has no mark');

  await p.screenshot({ path: `${SHOTS}/w35-player-page-light.png`, fullPage: true });

  // ── the ticket window's player card ───────────────────────────────────────────────────────────
  const conv = await admin('POST', '/conversations/initiate-email', {
    brandId: BRAND,
    playerId: PLAYER,
    subject: `w35 notes ${RUN}`,
    body: 'a ticket to open the card from',
  });
  const tid = conv.json?.id;
  if (!tid) {
    fail('F8 · could not create a ticket to open the card from', JSON.stringify(conv.json).slice(0, 160));
  } else {
    await p.goto(`${WEB}/tickets/${tid}`, { waitUntil: 'networkidle', timeout: 30000 });
    await p.waitForSelector('[data-testid="rail-player"]', { timeout: 20000 });
    // ⚠️ Opened by KEYBOARD: a second programmatic click on a Radix-adjacent trigger opens-and-closes
    // in one event (`gotchas/the-second-click-opens-and-closes`).
    await p.press('[data-testid="rail-player"]', 'Enter');
    await p.waitForSelector('[data-testid="player-notes"]', { timeout: 20000 });
    pass('F8 · the same notes area is inside the ticket window’s player card');

    /**
     * ⚠️ Wait for the LIST, not for the area.
     *
     * The section renders while the read is in flight (that is what its loading state is for), so
     * reading rows the moment `player-notes` appears measures the SKELETON — which is exactly what the
     * first run of this check did, reporting «the panel and the page disagree» about a note that was
     * simply not fetched yet. A comparison that races the fetch answers a different question every time.
     */
    await p.waitForSelector('[data-testid="player-notes-list"] [data-testid="player-note"]', {
      timeout: 20000,
    });

    const bodies = await p.$$eval('[data-testid="player-note"]', (els) =>
      els.map((e) => e.textContent ?? ''),
    );
    bodies.some((b) => b.includes(`w35 через экран ${RUN}`))
      ? pass('F9 · ⭐ both surfaces show the SAME notes — one read path, not two')
      : fail('F9 · the panel and the page disagree about the same customer');

    /**
     * ⚠️ The screenshot comes BEFORE the storm assertion, and that order is a correction: the assertion
     * CLICKS the rail button, which toggles the drawer SHUT — so the first light-panel shot of this check
     * was a frame with the panel closed, i.e. a picture of nothing. «A screenshot is one frame», the third
     * instance of that lesson in this project.
     */
    // ⚠️ …and it waits for the drawer to FINISH SLIDING. W26's round produced a dark shot taken
    // mid-slide that clipped every row to its right half; this check produced a light one with the
    // panel still translating and its identity block still a skeleton. The width transition is
    // `--motion-base`, so ~900ms is the settled frame rather than a guess at one.
    await p.waitForTimeout(900);
    await p.screenshot({ path: `${SHOTS}/w35-ticket-panel-light.png` });

    // The standing anti-storm assertion, on this block's key interaction: opening the panel.
    await assertNoRenderStorm({
      page: p,
      selector: '[data-testid="rail-player"]',
      pass,
      fail,
      settleMs: 2500,
    });
    // …and re-open it, so anything after this sees the panel the operator would.
    await p.press('[data-testid="rail-player"]', 'Enter');
    await p.waitForSelector('[data-testid="player-notes"]', { timeout: 20000 });
  }

  // ── dark, through the product's own control, and a RELOAD must come back dark ──────────────────
  await p.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.click('[data-testid="theme-dark"]');
  await p.waitForFunction(() => document.documentElement.classList.contains('dark'), undefined, {
    timeout: 8000,
  });
  await p.goto(`${WEB}/players/${BRAND}/${PLAYER}`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="player-notes"]', { timeout: 20000 });
  const stillDark = await p.evaluate(() => document.documentElement.classList.contains('dark'));
  stillDark
    ? pass('F10 · the theme is the PRODUCT’s, not a localStorage trick — it survives a reload')
    : fail('F10 · the reload came back light — the shot would be a frame the server reverts');
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${SHOTS}/w35-player-page-dark.png`, fullPage: true });

  if (tid) {
    await p.goto(`${WEB}/tickets/${tid}`, { waitUntil: 'networkidle', timeout: 30000 });
    await p.waitForSelector('[data-testid="rail-player"]', { timeout: 20000 });
    await p.press('[data-testid="rail-player"]', 'Enter');
    await p.waitForSelector('[data-testid="player-notes"]', { timeout: 20000 });
    // ⚠️ Wait for the drawer to finish sliding: a dark shot mid-slide clipped rows to their right
    // halves in W26's round.
    await p.waitForTimeout(900);
    await p.screenshot({ path: `${SHOTS}/w35-ticket-panel-dark.png` });
  }

  await p.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.click('[data-testid="theme-light"]');
  await p.waitForTimeout(800);
  pass('F11 · both-theme screenshots taken through the product control, theme restored');

  // ── the refusal, on the screen: the area is ABSENT for a role without clearance ────────────────
  const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1600, height: 1000 }, ...creds });
  const p2 = await ctx2.newPage();
  await signIn(p2, LEAD, ROLE_PW);

  /**
   * ⚠️ **Wait for the REFUSAL to land, then assert the absence.**
   *
   * The area renders while the read is in flight, so a fixed sleep asserts «is the area gone yet?» and
   * gets a different answer depending on the network — the first run of this check failed here for that
   * reason and not because the product rendered notes for a role with no clearance. Waiting on the
   * RESPONSE makes the assertion about the product's decision instead of about the page's timing, and it
   * doubles as the positive control: if the read never happened, this throws instead of passing.
   */
  const refusalSeen = p2
    .waitForResponse(
      (r) => r.url().includes(`/players/${PLAYER}/notes`) && r.request().method() === 'GET',
      { timeout: 25000 },
    )
    .catch(() => null);
  await p2.goto(`${WEB}/players/${BRAND}/${PLAYER}`, { waitUntil: 'networkidle', timeout: 30000 });
  await p2.waitForSelector('[data-testid="player-page-identity"]', { timeout: 20000 });
  const refusal = await refusalSeen;
  refusal && refusal.status() === 403
    ? pass('F12a · the notes read for a team lead is refused on the wire the page actually made (403)')
    : fail('F12a · no refused notes read was observed', `status=${refusal?.status() ?? 'none'}`);
  // The area disappears only once the error has arrived; give React the frame it needs to unmount.
  await p2.waitForFunction(() => !document.querySelector('[data-testid="player-notes"]'), undefined, {
    timeout: 10000,
  }).catch(() => {});
  const areaForLead = await p2.$$eval('[data-testid="player-notes"]', (els) => els.length);
  const saysEmpty = await p2.$$eval('[data-testid="player-notes-empty"]', (els) => els.length);
  areaForLead === 0 && saysEmpty === 0
    ? pass('F12 · ⭐ for a role without clearance the area is ABSENT — never an empty list claiming nothing was written')
    : fail('F12 · the notes area rendered for a role with no clearance', `area=${areaForLead} empty=${saysEmpty}`);
  await p2.screenshot({ path: `${SHOTS}/w35-player-page-no-clearance.png`, fullPage: true });
  await ctx2.close().catch(() => {});

  errors.length === 0
    ? pass('no uncaught page errors during the whole pass')
    : fail('page errors', errors.slice(0, 2).join(' | '));
  await ctx.close().catch(() => {});
} catch (err) {
  fail('the pass could not run', err instanceof Error ? err.message : String(err));
  // The failing FRAME, kept: a click timeout names a selector, never a state — the frame does.
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    for (let i = 0; i < pages.length; i += 1) {
      await pages[i].screenshot({ path: `${SHOTS}/w35-FAIL-${i}.png` });
    }
  } catch {
    /* best-effort — a dead browser must not mask the original failure */
  }
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW35: ${ok} passed, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
