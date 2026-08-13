/**
 * W19 browser check — my avatar, my status, as a person does it (5.4 + 5.5).
 *
 * The agent opens their own settings, adds a photo (a real PNG through the file picker), sees the
 * 256px thumb render; goes on Break, sees what break MEANS for routing, reloads — the state held
 * (it lives on the server, not in the tab); returns to shift. Anti-storm on the presence flip.
 */
import { chromium } from 'playwright';
import { assertNoRenderStorm } from './lib/no-render-storm.mjs';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-beton.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.1:8025';
const ROLE_PW = process.env.ROLE_PASSWORD ?? 'Stand#Role7x';
const AGENT = 'role-support-agent@beton.win';

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

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, ...creds });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', AGENT);
  await page.fill('input[type="password"]', ROLE_PW);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  await page.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(AGENT));
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });

  await page.goto(`${WEB}/settings`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForSelector('[data-testid="settings-profile"]', { timeout: 20000 });
  pass('the Profile section renders — the W18 slot became real');

  // ── the avatar, through the real file picker ─────────────────────────────────────────────────────
  await page.setInputFiles('[data-testid="avatar-file"]', {
    name: 'me.png',
    mimeType: 'image/png',
    buffer: PNG_1PX,
  });
  await page.waitForSelector('[data-testid="avatar-image"]', { timeout: 20000 });
  const src = await page.$eval('[data-testid="avatar-image"]', (el) => el.getAttribute('src') ?? '');
  if (/\/uploads\/.+\/thumb$/.test(src)) pass('⭐ the photo went in and the 256px THUMB renders — never the original on a row');
  else fail('thumb src', src.slice(0, 80));
  const imgOk = await page.$eval('[data-testid="avatar-image"]', (el) => el.naturalWidth > 0);
  if (imgOk) pass('…and the image actually LOADED (naturalWidth > 0), not a broken link');
  else fail('avatar image loads', 'naturalWidth = 0');

  // ── presence: break, reload, back ────────────────────────────────────────────────────────────────
  // Start from a known state.
  await page.click('[data-testid="presence-online"]');
  await page.waitForTimeout(1000);
  await assertNoRenderStorm({ page, selector: '[data-testid="presence-away"]', pass, fail });
  await page.waitForSelector('[data-testid="presence-note"]', { timeout: 10000 });
  pass('⭐ Break is on, and the page SAYS what break means: new tickets are not routed to you');

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="presence-note"]', { timeout: 20000 });
  pass('⭐ …and a RELOAD still shows Break — the state lives on the server, not in the tab');

  await page.click('[data-testid="presence-online"]');
  await page.waitForFunction(() => !document.querySelector('[data-testid="presence-note"]'), undefined, { timeout: 10000 });
  pass('…back on shift for whoever runs next');

  if (errors.length === 0) pass('no uncaught page errors');
  else fail('page errors', errors[0]);
  await ctx.close();
} catch (err) {
  fail('the pass could not run', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW19 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
