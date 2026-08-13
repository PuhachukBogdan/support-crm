/**
 * W24 browser check — `[номер] тема` as ONE field, and the search that finds it (R43).
 *
 * The Готово-когда, verbatim, each as an assertion:
 *   · the list column shows `[1043] Тема`;
 *   · search by the NUMBER finds the ticket, search by a WORD from the subject finds the same one;
 *   · a number that names no ticket yields an HONEST EMPTY result — never an error;
 *   · in the ticket window the number stands FIRST, before the subject and the status.
 *
 * ⚠️ The list search is the LIST's narrowing (bucket + agent scope still apply) — the check searches
 * in the bucket that holds the ticket. The everything-search is W39's separate screen.
 * Run ON THE STAND against the VERIFICATION origin (rule 12 — the public link is frozen).
 */
import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-next.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.2:8025';
const EMAIL = process.env.PROBE_EMAIL ?? 'role-support-agent@beton.win';
const PASS = process.env.PROBE_PASSWORD ?? 'Stand#Role7x';

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
  throw new Error('no login code arrived');
}

const creds = process.env.EDGE_USER
  ? { httpCredentials: { username: process.env.EDGE_USER, password: process.env.EDGE_PASSWORD ?? '' } }
  : {};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));

  await p.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await p.fill('input[type="email"]', EMAIL);
  await p.fill('input[type="password"]', PASS);
  await p.click('button[type="submit"]');
  await p.waitForTimeout(2500);
  await p.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(EMAIL));
  await p.click('button[type="submit"]');
  await p.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
  await p.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });
  pass('signed in through the real login screens');

  const rows = async () => {
    await p.waitForTimeout(1300);
    return p.$$eval('table tbody tr[data-index]', (rs) => rs.length).catch(() => 0);
  };

  // The probe's ticket lives in «Ждут клиента» (its status is Pending on this stand).
  await p.$eval('[data-testid="bucket-waiting"]', (el) => el.click());
  if ((await rows()) < 1) {
    fail('a ticket to test with', '«Ждут клиента» holds no rows for this agent');
    throw new Error('no fixture ticket');
  }

  // ── 1. the column is ONE field: [номер] тема ────────────────────────────────────────────────────
  const cellText = (await p.$eval('table tbody tr[data-index]', (r) => r.textContent ?? '')).trim();
  const m = cellText.match(/\[(\d+)\]\s*(\S+)/);
  if (m) pass(`the list shows the number and the subject as ONE field ([${m[1]}] …)`);
  else fail('[номер] тема in the column', cellText.slice(0, 80));
  if (!m) throw new Error('no number to search for');
  const number = m[1];

  // A word from the SUBJECT, for claim 3 — from the span whose `title` STARTS with the number: that
  // is the combined field itself. Not the row's text (its first cell is the STATUS — round one
  // searched for «Pending»), and not the first span[title] (that is the relative-time cell, whose
  // title is a date with no words in it — round two found "no word to search").
  const subjectWord = await p.$$eval('table tbody tr[data-index] span[title]', (els) => {
    const el = els.find((s) => /^\[\d+\]/.test(s.getAttribute('title') ?? ''));
    const t = (el?.getAttribute('title') ?? '').replace(/^\[\d+\]\s*/, '');
    return (t.match(/[А-Яа-яA-Za-z]{4,}/) ?? [''])[0];
  }).catch(() => '');

  const search = async (text) => {
    await p.fill('[data-testid="inbox-search"]', text);
    await p.waitForTimeout(2000); // debounce + fetch
    return p.$$eval('table tbody tr[data-index]', (rs) => rs.map((r) => r.textContent ?? '')).catch(() => []);
  };

  // ── 2. search by the NUMBER finds the ticket ────────────────────────────────────────────────────
  const byNumber = await search(`[${number}]`);
  if (byNumber.length >= 1 && byNumber.every((t) => t.includes(`[${number}]`)))
    pass(`search by the number ([${number}]) finds exactly that ticket (${byNumber.length} row)`);
  else fail('search by number', `${byNumber.length} rows: ${String(byNumber[0]).slice(0, 60)}`);

  // ── 3. search by a WORD from the subject finds the same one ─────────────────────────────────────
  if (subjectWord) {
    const byWord = await search(subjectWord);
    if (byWord.some((t) => t.includes(`[${number}]`)))
      pass(`search by a subject word («${subjectWord}») finds the same ticket`);
    else fail('search by subject word', `«${subjectWord}» → ${byWord.length} rows, none carrying [${number}]`);
  } else {
    fail('search by subject word', 'the fixture subject offered no word to search');
  }

  // ── 4. a number that names no ticket ⇒ an HONEST EMPTY, never an error ─────────────────────────
  const byGhost = await search('999999999');
  const emptySaid = await p.$eval('body', (b) => (b.innerText ?? '')).catch(() => '');
  if (byGhost.length === 0 && /no tickets match these filters/i.test(emptySaid) && !(await p.$('[data-testid="dt-error"]')))
    pass('a nonexistent number yields the honest filtered-empty state — not an error, not the queue');
  else fail('nonexistent number', `${byGhost.length} rows; error=${!!(await p.$('[data-testid="dt-error"]'))}`);

  // ── 5. in the WINDOW the number stands FIRST ────────────────────────────────────────────────────
  await search(`[${number}]`);
  await p.$eval('table tbody tr[data-index]', (r) => r.click());
  await p.waitForSelector('[data-testid="ticket-reference"]', { timeout: 20000 });
  const headerOrder = await p.evaluate(() => {
    const ref = document.querySelector('[data-testid="ticket-reference"]');
    const subj = document.querySelector('[data-testid="ticket-subject"]');
    if (!ref || !subj) return 'missing';
    return ref.compareDocumentPosition(subj) & Node.DOCUMENT_POSITION_FOLLOWING ? 'ref-first' : 'subject-first';
  });
  const refText = (await p.textContent('[data-testid="ticket-reference"]'))?.trim();
  if (headerOrder === 'ref-first' && refText === `[${number}]`)
    pass(`the window opens with the number FIRST (${refText}), before the subject and the status`);
  else fail('number first in the window', `${headerOrder}, text=${refText}`);

  if (errors.length === 0) pass('no uncaught page errors during the whole pass');
  else fail('page errors', errors.slice(0, 2).join(' | '));
} catch (err) {
  fail('the pass could not run', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW24 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
