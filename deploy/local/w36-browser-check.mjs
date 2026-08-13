/**
 * W36 live check — password recovery and change as BEHAVIOUR (roadmap 3.18 + 8.11, spec 041).
 *
 *   A  ⭐ POSITIVE CONTROL: a real address gets a link and the link SETS a password
 *   B  ⭐ the answer is byte-identical for a known and an unknown address (status, headers, body)
 *   C  ⛔ the link works ONCE; the second use is refused and the password is unchanged
 *   D  ⭐⭐ a refresh token captured BEFORE recovery no longer renews — with its negative control
 *   E  ⛔ completing recovery sets NO cookie, and the two-step login is still required
 *   F  the trail: one entry per request, `player`-free, no address anywhere in it
 *   G  the signed-in change: wrong current password refused, right one revokes everything
 *   H  the screens in a browser, both themes, screenshots
 *
 * ⚠️ Run ON THE STAND against the VERIFICATION origin (rule 12 — the public link is frozen).
 * ⚠️ It CHANGES a stand password on purpose (that is the feature). The account and both passwords are
 *    printed at the end so the next round is not locked out.
 */
import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-next.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.2:8025';
const SUBJECT = process.env.SUBJECT_EMAIL ?? 'role-shift-am@beton.win';
const SUBJECT_PW = process.env.SUBJECT_PASSWORD ?? 'Stand#Role7x';
const OWNER = process.env.OWNER_EMAIL ?? 'warden@beton.win';
const OWNER_PW = process.env.OWNER_PASSWORD ?? 'Stand#Owner9x';
const SHOTS = process.env.SHOT_DIR ?? '/tmp/pw-work/shots-w36';
/** The password recovery will set. Printed at the end — the stand keeps it. */
const NEW_PW = process.env.NEW_PASSWORD ?? 'Recovered#2026x';

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

const api = `${WEB}/api`;
const jsonHeaders = () => ({ 'Content-Type': 'application/json', ...edgeHeaders() });

/** A raw call that keeps the whole response, because B compares headers and body, not just a status. */
async function call(method, path, body, cookie) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { ...jsonHeaders(), ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return {
    status: res.status,
    text,
    json,
    setCookie: res.headers.getSetCookie?.() ?? [],
    /** The headers that could differ between two answers. Date/length are excluded as noise. */
    shape: [...res.headers.entries()]
      .filter(([k]) => !['date', 'content-length', 'etag'].includes(k))
      .map(([k, v]) => `${k}:${v}`)
      .sort()
      .join('|'),
  };
}

async function codeFor(email, since = 0) {
  for (let i = 0; i < 25; i += 1) {
    const res = await fetch(`${MAIL}/api/v1/search?query=to%3A${encodeURIComponent(email)}&limit=5`, {
      headers: edgeHeaders(),
    });
    const body = JSON.stringify(await res.json().catch(() => ({})));
    const m = body.match(/code: ([A-Z0-9]{6})/);
    if (m && Date.now() > since) return m[1];
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no login code for ${email}`);
}

/**
 * The recovery LINK, out of the interceptor. The token exists in clear in exactly this one place.
 *
 * ⚠️ **Read the FULL message, and undo quoted-printable, or the token arrives truncated.** The first run
 * of this check failed every downstream assertion with `bad_token`, and the product was right: the link is
 * ~160 characters, SMTP wraps it with soft line breaks (`=\r\n`), and the search endpoint answers a
 * SNIPPET. Matching a URL in either of those yields a secret missing its tail — a check defect that reads
 * exactly like a broken feature.
 */
/** The recovery message IDs that exist right now — snapshotted BEFORE a request. */
async function recoveryIdsFor(email) {
  const list = await fetch(`${MAIL}/api/v1/search?query=to%3A${encodeURIComponent(email)}&limit=20`, {
    headers: edgeHeaders(),
  });
  const found = await list.json().catch(() => ({}));
  return new Set(
    (found?.messages ?? [])
      .filter((m) => /new password/i.test(String(m?.Subject ?? '')))
      .map((m) => m.ID),
  );
}

async function recoveryTokenFor(email, seen = new Set()) {
  for (let i = 0; i < 25; i += 1) {
    const list = await fetch(`${MAIL}/api/v1/search?query=to%3A${encodeURIComponent(email)}&limit=5`, {
      headers: edgeHeaders(),
    });
    const found = await list.json().catch(() => ({}));
    /**
     * ⚠️ **NEWEST FIRST, explicitly.** The second run of this check failed with `expired` on every
     * downstream assertion — and the product was right again: the mailbox still held the link from the
     * PREVIOUS run, issuing a new one VOIDS the old (one live token per person, by design), and the check
     * was reading the dead one. Relying on the search endpoint's default order is the
     * *fixture-is-not-what-the-script-believes* class in its purest form.
     */
    const messages = [...(found?.messages ?? [])]
      /**
       * ⚠️⚠️ **ONLY messages newer than the request this call is waiting for.** Runs two and three of this
       * check failed with `expired` on everything downstream, and the product was right BOTH times: the
       * mailbox still held links from earlier runs, issuing a new one VOIDS the old (one live token per
       * person, by design), and the outbox delivers a beat AFTER the request returns — so a loop that
       * accepts any matching message reads a dead token on its first iteration.
       *
       * Waiting for a message newer than a timestamp taken BEFORE the request is the same rule as «poll
       * until the server holds the value»: it pins WHICH state is being read instead of reading whatever
       * is there.
       */
      // ⚠️ Identified by WHAT THE MESSAGE IS (the recovery subject), not only by when it arrived: the
      // mailbox also holds sign-in codes for this address, and the container's clock and the mailbox's are
      // not the same clock — a tight timestamp window rejected everything on run four. The window stays,
      // generously, so a link from a PREVIOUS run cannot win; the subject is what makes the pick precise.
      .filter((m) => /new password/i.test(String(m?.Subject ?? '')))
      /**
       * ⚠️⚠️ **A NEW message ID, not a timestamp.** The ±60s window this replaced let the SECOND
       * consecutive run pick up the FIRST run's already-consumed link — and «already used» then passed for
       * the wrong reason, which is a vacuous pass hiding inside a green assertion. Identity beats time:
       * the ids that existed before the request are excluded, so the message read is necessarily the one
       * this request caused. Clocks stop mattering at all.
       */
      .filter((m) => !seen.has(m.ID))
      .sort((a, b) => new Date(b?.Created ?? 0).getTime() - new Date(a?.Created ?? 0).getTime());
    for (const msg of messages) {
      const full = await fetch(`${MAIL}/api/v1/message/${msg.ID}`, { headers: edgeHeaders() });
      const body = await full.json().catch(() => ({}));
      // Soft line breaks first, then match: `=\r\n` is a WRAP, not part of the token.
      const text = String(body?.Text ?? '').replace(/=\r?\n/g, '');
      const m = text.match(/recover\/complete\?token=([^\s"'<>]+)/);
      if (m) return decodeURIComponent(m[1]);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no recovery link for ${email}`);
}

/** A full two-step sign-in, returning the cookie jar. This is what «still required» means. */
async function signInApi(email, password) {
  const login = await call('POST', '/auth/login', { email, password });
  if (login.status !== 200 || !login.json?.challengeId) {
    throw new Error(`login step 1 failed for ${email}: ${login.status} ${login.text.slice(0, 120)}`);
  }
  await new Promise((r) => setTimeout(r, 2500));
  const verify = await call('POST', '/auth/verify', {
    challengeId: login.json.challengeId,
    code: await codeFor(email),
  });
  const cookie = verify.setCookie.map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`verify produced no cookie for ${email}`);
  return cookie;
}

/**
 * The refresh cookie's value out of a jar.
 *
 * ⚠️ The cookie is named `refresh`, not `crm_refresh` — the first version of this helper guessed the
 * prefixed name, found nothing, and reported «the captured cookie carried no refresh token at all» beside a
 * passing D1. An anti-vacuous check that is itself vacuous is worse than none: it says the real assertion
 * might have been empty when it was not. The name is `REFRESH_COOKIE` in
 * `services/gateway/src/auth/session-cookie.ts`.
 */
const refreshValue = (cookie) => /(?:^|;\s*)refresh=([^;]+)/.exec(cookie ?? '')?.[1] ?? '';

/**
 * Fill a CONTROLLED input on a page that may still be hydrating, and prove the value held.
 *
 * ⚠️ A plain `fill` sets the DOM value; if React has not attached yet it re-renders from state and the
 * field goes empty again — leaving a submit button disabled forever and a click timing out against
 * «element is not enabled». That is what failed the first browser leg of this check. Filling until the
 * value SURVIVES a read is the same rule as «poll until the server holds the value», applied to a page
 * instead of a server.
 */
async function fillHeld(page, selector, value) {
  for (let i = 0; i < 20; i += 1) {
    await page.fill(selector, value);
    await page.waitForTimeout(150);
    if ((await page.inputValue(selector)) === value) return;
  }
  throw new Error(`the value did not hold in ${selector}`);
}

const browser = await chromium.launch();
try {
  const owner = await signInApi(OWNER, OWNER_PW);
  /**
   * ⚠️⚠️ **The trail is APPEND-ONLY, so «there are recovery entries» is not an assertion.** The entries
   * from the previous run are still there and would carry F1 and F3 on their own — a green line with
   * nothing behind it, the same vacuous shape that the ±60s mail window produced. What can honestly be
   * asserted is the **delta**: the ids that exist before this run are excluded, so every entry counted
   * below was written by it.
   */
  const auditIds = async () => {
    const res = await call('GET', '/audit?pageSize=50', undefined, owner);
    return new Set((res.json?.entries ?? []).map((e) => e.id));
  };
  const trailBefore = await auditIds();

  // ═══ D's negative control FIRST: the subject's session renews BEFORE recovery ═════════════════
  const before = await signInApi(SUBJECT, SUBJECT_PW);
  const renewBefore = await call('POST', '/auth/refresh', {}, before);
  renewBefore.status === 200
    ? pass('D0 · ⭐ NEGATIVE CONTROL: the captured session renews BEFORE recovery')
    : fail('D0 · the session did not renew even before recovery', `${renewBefore.status}`);
  // The rotation replaced the cookie; keep the newest one, which is what must die.
  const live = renewBefore.setCookie.length
    ? renewBefore.setCookie.map((c) => c.split(';')[0]).join('; ')
    : before;

  // ═══ B · the answer never varies ═════════════════════════════════════════════════════════════
  const seenBefore = await recoveryIdsFor(SUBJECT);
  const known = await call('POST', '/auth/recovery', { email: SUBJECT });
  const unknown = await call('POST', '/auth/recovery', { email: 'nobody-at-all@example.test' });
  known.status === 202 && unknown.status === 202
    ? pass('B1 · both a known and an unknown address answer 202')
    : fail('B1 · the statuses differ', `${known.status} vs ${unknown.status}`);
  known.text === unknown.text
    ? pass(`B2 · ⭐ the BODY is byte-identical (${known.text})`)
    : fail('B2 · the bodies differ', `${known.text} vs ${unknown.text}`);
  known.shape === unknown.shape
    ? pass('B3 · ⭐ the response HEADERS are identical too — nothing to measure')
    : fail('B3 · the headers differ', `${known.shape}\n${unknown.shape}`);

  // ═══ A · the link works ══════════════════════════════════════════════════════════════════════
  const token = await recoveryTokenFor(SUBJECT, seenBefore);
  token.includes('.')
    ? pass('A1 · the interceptor carries a link with an `<id>.<secret>` token')
    : fail('A1 · no usable token in the message', token.slice(0, 40));

  const completed = await call('POST', '/auth/recovery/complete', { token, password: NEW_PW });
  completed.status === 200 && completed.json?.outcome === 'ok'
    ? pass(`A2 · ⭐ POSITIVE CONTROL: the link SETS the password (revokedCount=${completed.json?.revokedCount})`)
    : fail('A2 · the link did not set a password', `${completed.status} ${completed.text.slice(0, 160)}`);

  // ═══ E · no session from recovery ════════════════════════════════════════════════════════════
  completed.setCookie.length === 0
    ? pass('E1 · ⭐ completion sets NO cookie — recovery is not a login (FR-009)')
    : fail('E1 · recovery handed out a session', completed.setCookie.join(' | '));
  !/accessToken|refreshToken/i.test(completed.text)
    ? pass('E2 · …and no token in the body either')
    : fail('E2 · a token travelled in the body', completed.text.slice(0, 120));

  // ═══ D · the old session is dead ═════════════════════════════════════════════════════════════
  const renewAfter = await call('POST', '/auth/refresh', {}, live);
  renewAfter.status !== 200
    ? pass(`D1 · ⭐⭐ the session captured before recovery no longer renews (${renewAfter.status})`)
    : fail('D1 · a pre-recovery session still renews — «every session dies» is a claim, not a fact');
  refreshValue(live) !== ''
    ? pass('D2 · …and the token it was asked with was a real one (not an empty jar passing vacuously)')
    : fail('D2 · the captured cookie carried no refresh token at all');

  // ═══ E · the two-step login still applies, with the NEW password ═════════════════════════════
  const step1 = await call('POST', '/auth/login', { email: SUBJECT, password: NEW_PW });
  step1.status === 200 && step1.json?.challengeId && step1.setCookie.length === 0
    ? pass('E3 · ⭐ signing in with the new password still needs the emailed CODE — no token at step 1')
    : fail('E3 · the two-step login was bypassed or refused', `${step1.status} ${step1.text.slice(0, 120)}`);
  const oldPw = await call('POST', '/auth/login', { email: SUBJECT, password: SUBJECT_PW });
  oldPw.status === 401
    ? pass('E4 · the OLD password is refused — the change is real, not additive')
    : fail('E4 · the old password still works', `${oldPw.status}`);

  // ═══ C · once, and only once ═════════════════════════════════════════════════════════════════
  const again = await call('POST', '/auth/recovery/complete', { token, password: 'Second#Attempt1' });
  again.status === 410 && again.json?.outcome === 'already_used'
    ? pass('C1 · ⛔ the same link a second time is refused as already used (410)')
    : fail('C1 · the link was reusable', `${again.status} ${again.text.slice(0, 120)}`);
  const stillNew = await call('POST', '/auth/login', { email: SUBJECT, password: NEW_PW });
  stillNew.status === 200
    ? pass('C2 · …and the password is UNCHANGED by that attempt')
    : fail('C2 · the refused attempt changed the password anyway', `${stillNew.status}`);

  // ═══ F · the trail ═══════════════════════════════════════════════════════════════════════════
  const trail = await call('GET', '/audit?pageSize=50', undefined, owner);
  const authEntries = (trail.json?.entries ?? [])
    .filter((e) => !trailBefore.has(e.id)) // ⭐ THIS RUN's entries only — see `auditIds` above
    .filter((e) => String(e.action ?? '').startsWith('recovery.') || e.action === 'password.changed');
  authEntries.length > 0
    ? pass(`F1 · ⭐ THIS run appended ${authEntries.length} authentication entries (delta, not a total)`)
    : fail('F1 · nothing from this feature reached the trail', JSON.stringify(trail.json).slice(0, 160));
  const serialized = JSON.stringify(authEntries);
  !serialized.includes('@')
    ? pass('F2 · ⭐ no address anywhere in them — only the salted hash')
    : fail('F2 · an address reached the trail', serialized.slice(0, 200));
  authEntries.some((e) => e.action === 'recovery.requested') &&
  authEntries.some((e) => e.action === 'recovery.completed')
    ? pass('F3 · both the request and the completion are recorded')
    : fail('F3 · one half of the story is missing', authEntries.map((e) => e.action).join(','));

  // ═══ G · the signed-in change ════════════════════════════════════════════════════════════════
  const session = await signInApi(SUBJECT, NEW_PW);
  const wrong = await call('POST', '/auth/password', { currentPassword: 'not-it', newPassword: SUBJECT_PW }, session);
  wrong.status === 401
    ? pass('G1 · the wrong current password is refused (401)')
    : fail('G1 · a wrong current password was accepted', `${wrong.status} ${wrong.text.slice(0, 120)}`);
  const changed = await call('POST', '/auth/password', { currentPassword: NEW_PW, newPassword: SUBJECT_PW }, session);
  changed.status === 200 && changed.json?.outcome === 'ok'
    ? pass(`G2 · ⭐ the change succeeds and reports the sessions it ended (${changed.json?.revokedCount})`)
    : fail('G2 · the change failed', `${changed.status} ${changed.text.slice(0, 160)}`);
  const afterChange = await call('POST', '/auth/refresh', {}, session);
  afterChange.status !== 200
    ? pass('G3 · the caller’s OWN session is among the revoked')
    : fail('G3 · the session that changed the password still renews');
  note(`the stand's ${SUBJECT} password is back to its original value`);

  // ═══ H · the screens ═════════════════════════════════════════════════════════════════════════
  const creds = process.env.EDGE_USER
    ? { httpCredentials: { username: process.env.EDGE_USER, password: process.env.EDGE_PASSWORD ?? '' } }
    : {};
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, ...creds });
  const errors = [];
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));

  await p.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="login-forgot-password"]', { timeout: 20000 });
  pass('H1 · ⭐ sign-in offers the way to recovery (without it the capability is unreachable)');
  // ⚠️ The link's DESTINATION is asserted, then the screen is loaded FRESH. Arriving by click left the page
  // mid-hydration: the DOM took the typed value while React's state stayed empty, so the submit button
  // remained disabled and the click timed out against a page that was, to a person, perfectly usable. The
  // claim «the link leads there» does not need the same page instance as the interaction test.
  const href = await p.getAttribute('[data-testid="login-forgot-password"]', 'href');
  href === '/recover'
    ? pass('H2 · …and it points at the request screen')
    : fail('H2 · the link points elsewhere', String(href));
  await p.goto(`${WEB}/recover`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="recovery-email"]', { timeout: 20000 });

  const seenBeforeBrowser = await recoveryIdsFor(SUBJECT);
  await fillHeld(p, '[data-testid="recovery-email"]', SUBJECT);
  await p.click('[data-testid="recovery-submit"]');
  await p.waitForSelector('[data-testid="recovery-sent"]', { timeout: 20000 });
  const sentText = (await p.textContent('[data-testid="recovery-sent"]')) ?? '';
  !sentText.includes(SUBJECT)
    ? pass('H3 · ⭐ the confirmation does not repeat the address back')
    : fail('H3 · the confirmation echoed the address — that confirms the account exists');
  await p.screenshot({ path: `${SHOTS}/w36-recover-light.png`, fullPage: true });

  // The link this browser round produced, opened as a person would.
  const browserToken = await recoveryTokenFor(SUBJECT, seenBeforeBrowser);
  await p.goto(`${WEB}/recover/complete?token=${encodeURIComponent(browserToken)}`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await p.waitForSelector('[data-testid="recovery-password"]', { timeout: 20000 });
  await fillHeld(p, '[data-testid="recovery-password"]', 'weak');
  await p.click('[data-testid="recovery-complete-submit"]');
  await p.waitForSelector('[data-testid="recovery-weak"]', { timeout: 20000 });
  const weakText = (await p.textContent('[data-testid="recovery-weak"]')) ?? '';
  /digit|symbol|upper|characters/i.test(weakText)
    ? pass(`H4 · a weak password names the RULES («${weakText.trim()}»)`)
    : fail('H4 · the policy failure was generic', weakText);
  await p.screenshot({ path: `${SHOTS}/w36-complete-weak-light.png`, fullPage: true });

  await fillHeld(p, '[data-testid="recovery-password"]', NEW_PW);
  await p.click('[data-testid="recovery-complete-submit"]');
  await p.waitForSelector('[data-testid="recovery-complete-ok"]', { timeout: 20000 });
  const okText = (await p.textContent('[data-testid="recovery-complete-ok"]')) ?? '';
  /sign in/i.test(okText)
    ? pass('H5 · ⭐ success sends the person to SIGN IN — it does not pretend they are in')
    : fail('H5 · the success state implied a session', okText.slice(0, 120));
  await p.screenshot({ path: `${SHOTS}/w36-complete-ok-light.png`, fullPage: true });
  // ⚠️ Put the password back so the stand's documented credential keeps working.
  const back = await signInApi(SUBJECT, NEW_PW);
  await call('POST', '/auth/password', { currentPassword: NEW_PW, newPassword: SUBJECT_PW }, back);

  // A dead link, as a person meets it.
  await p.goto(`${WEB}/recover/complete?token=${encodeURIComponent(browserToken)}`, {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await fillHeld(p, '[data-testid="recovery-password"]', 'Whatever#2026x');
  await p.click('[data-testid="recovery-complete-submit"]');
  await p.waitForSelector('[data-testid="recovery-link-dead"]', { timeout: 20000 });
  const deadText = (await p.textContent('[data-testid="recovery-link-dead"]')) ?? '';
  /ask for a new one/i.test(deadText)
    ? pass('H6 · a dead link says what to do next')
    : fail('H6 · the dead-link state left the person without an action', deadText.slice(0, 120));
  await p.screenshot({ path: `${SHOTS}/w36-complete-dead-light.png`, fullPage: true });

  // ── the change control, and both themes, through the product's own control ─────────────────────
  const signedIn = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, ...creds });
  const s = await signedIn.newPage();
  await s.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await fillHeld(s, 'input[type="email"]', SUBJECT);
  await fillHeld(s, 'input[type="password"]', SUBJECT_PW);
  await s.click('button[type="submit"]');
  await s.waitForTimeout(2500);
  await s.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(SUBJECT));
  await s.click('button[type="submit"]');
  await s.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });

  await s.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
  await s.waitForSelector('[data-testid="change-password"]', { timeout: 20000 });
  pass('H7 · the change-password control is on the settings screen');
  await s.screenshot({ path: `${SHOTS}/w36-settings-light.png`, fullPage: true });

  await s.click('[data-testid="theme-dark"]');
  await s.waitForFunction(() => document.documentElement.classList.contains('dark'), undefined, { timeout: 8000 });
  await s.reload({ waitUntil: 'networkidle' });
  const stillDark = await s.evaluate(() => document.documentElement.classList.contains('dark'));
  stillDark
    ? pass('H8 · the theme is the PRODUCT’s — it survives a reload')
    : fail('H8 · the reload came back light — the dark shots would be frames the server reverts');
  await s.waitForSelector('[data-testid="change-password"]', { timeout: 20000 });
  await s.screenshot({ path: `${SHOTS}/w36-settings-dark.png`, fullPage: true });

  const dark = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 }, ...creds });
  const d = await dark.newPage();
  await d.goto(`${WEB}/recover`, { waitUntil: 'networkidle', timeout: 30000 });
  await d.waitForSelector('[data-testid="recovery-email"]', { timeout: 20000 });
  await d.waitForTimeout(600);
  await d.screenshot({ path: `${SHOTS}/w36-recover-dark.png`, fullPage: true });
  await d.goto(`${WEB}/recover/complete?token=nope.nope`, { waitUntil: 'networkidle', timeout: 30000 });
  await d.waitForTimeout(600);
  await d.screenshot({ path: `${SHOTS}/w36-complete-dark.png`, fullPage: true });
  pass('H9 · both-theme screenshots taken (the auth screens carry their own dark backdrop by design)');

  await s.click('[data-testid="theme-light"]').catch(() => {});
  await s.waitForTimeout(600);

  errors.length === 0
    ? pass('no uncaught page errors during the whole pass')
    : fail('page errors', errors.slice(0, 2).join(' | '));
  await Promise.all([ctx.close(), signedIn.close(), dark.close()].map((x) => x.catch?.(() => {}) ?? x));
} catch (err) {
  fail('the pass could not run', err instanceof Error ? err.message : String(err));
  try {
    const pages = browser.contexts().flatMap((c) => c.pages());
    for (let i = 0; i < pages.length; i += 1) await pages[i].screenshot({ path: `${SHOTS}/w36-FAIL-${i}.png` });
  } catch {
    /* best-effort */
  }
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW36: ${ok} passed, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
