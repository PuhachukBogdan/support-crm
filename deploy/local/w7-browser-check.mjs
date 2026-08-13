/**
 * W7 browser check — the ticket window on the PUBLIC origin (block W7, subpoint 2.6).
 *
 * What only a real browser can answer:
 *   · a REAL click on an Inbox row actually lands (no overlay, no dead region) and opens the window
 *   · ⭐ opening a ticket causes NO re-render storm — the standing rule's first consumer beyond W6
 *   · a note round-trips and renders AS a note (chip), a reply as a reply
 *   · a real file crosses the multipart edge and comes back as an attachment in the thread
 *   · «Submit as <status>» changes the header's status in one gesture
 *   · tags attach and detach through the real registry
 *
 * ⚠️ Same container limit as W6, stated: real-input clicks wedge this image's Chromium at ~the
 * sixth, per BROWSER. Real clicks are spent where real input proves something (the row, one send);
 * everything else is DOM clicks or the keyboard, labelled so nothing reads as more than it is.
 *
 * ⓘ NOT here, and why: «take it» — the Inbox is self-scoped, so every ticket this agent can open is
 * already theirs and the control is correctly ABSENT (asserted); live-refresh across two sessions —
 * the socket's delivery is W4's proven claim, and the window's id-scoping is asserted in jsdom.
 */
import { chromium } from 'playwright';
import { assertNoRenderStorm } from './lib/no-render-storm.mjs';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-beton.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.1:8025';
const EMAIL = process.env.PROBE_EMAIL ?? 'seed-agent2@example.test';
const PASS = process.env.PROBE_PASSWORD ?? 'Stand#Seed7x';

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
  throw new Error('no login code arrived');
}

const creds = process.env.EDGE_USER
  ? { httpCredentials: { username: process.env.EDGE_USER, password: process.env.EDGE_PASSWORD ?? '' } }
  : {};

// A real 1×1 PNG: the upload purpose detects type BY CONTENT, so the bytes must be genuine.
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// ── Sign in ONCE, in its own browser, so its clicks do not spend the interaction budget.
const signer = await chromium.launch();
let state;
try {
  const ctx = await signer.newContext({ ignoreHTTPSErrors: true, ...creds });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  await page.fill('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]', await codeFor(EMAIL));
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
  await page.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });
  state = await ctx.storageState();
  pass('signed in through the real login screens');
} catch (err) {
  fail('sign-in', err instanceof Error ? err.message : String(err));
} finally {
  await signer.close().catch(() => {});
}

if (!state) {
  console.log(`\nW7 browser: ${ok} ok, ${bad} failed`);
  process.exit(1);
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: state,
    viewport: { width: 1920, height: 1080 },
    ...creds,
  });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));

  await p.goto(WEB, { waitUntil: 'networkidle', timeout: 30000 });
  await p.waitForSelector('[data-testid="bucket-rail"]', { timeout: 20000 });
  // ⚠️ A DATA row (`data-index`), not any tbody row: the loading skeleton is also a row, carries no
  // click handler, and a freshly restarted container is slow enough to serve it — the storm
  // assertion then measures a click on nothing (0 posts, no window; one run failed exactly so).
  // ⚠️ And the row is hunted ACROSS BUCKETS: this check moves a ticket's status every run («Submit
  // as In progress»), so the bucket that held a ticket last run may be empty this run — the check
  // must survive its own history.
  let bucketWithRows = '';
  for (const b of ['inbox', 'open', 'pending', 'solved', 'archive']) {
    await p.$eval(`[data-testid="bucket-${b}"]`, (el) => el.click()).catch(() => {});
    const row = await p.waitForSelector('table tbody tr[data-index]', { timeout: 5000 }).catch(() => null);
    if (row) { bucketWithRows = b; break; }
  }
  if (bucketWithRows === '') throw new Error('no bucket holds a ticket for the probe agent');
  note(`tickets found in bucket «${bucketWithRows}» (dom clicks)`);

  // A unique tag for this run, created through the product's own edge BEFORE the window opens,
  // so the window's one labels read already offers it. Unique ⇒ re-runs never hit (account, name).
  const TAG = `w7check-${Date.now().toString(36)}`;
  const tagCreated = await p.evaluate(async (name) => {
    const res = await fetch('/api/labels', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, color: '#8888ff' }),
    });
    return res.ok;
  }, TAG);
  if (tagCreated) pass(`a tag exists to offer (created «${TAG}» through the real edge)`);
  else fail('tag setup', 'POST /api/labels refused');

  // ── 1. ⭐⭐ the ANTI-STORM assertion on this block's key interaction: opening a ticket ──────────
  // The standing rule's first consumer beyond W6 (deploy/local/lib/no-render-storm.mjs, commit
  // 953493d). The DOM click inside the measurement IS the navigation — measured, not repeated.
  await assertNoRenderStorm({ page: p, selector: 'table tbody tr[data-index]', pass, fail });

  await p.waitForSelector('[data-testid="ticket-window"]', { timeout: 15000 });
  if (p.url().includes('/tickets/')) pass('a click on a row opened ITS ticket (URL carries the id)');
  else fail('row opens ticket', p.url());

  // ── 2. the window renders the record ────────────────────────────────────────────────────────────
  const subject = (await p.textContent('[data-testid="ticket-subject"]').catch(() => '')) ?? '';
  if (subject.trim() !== '') pass(`the header carries the 4.18 subject («${subject.trim().slice(0, 40)}»)`);
  else fail('subject rendered');

  const statusBefore = ((await p.textContent('[data-testid="ticket-status"]').catch(() => '')) ?? '').trim();
  if (statusBefore !== '' && !statusBefore.includes('_')) pass(`the status chip shows the catalogue NAME («${statusBefore}»)`);
  else fail('status chip', statusBefore);

  // An EMPTY thread is a legitimate state (a routed ticket can hold zero visible messages) — what
  // the check demands is that the screen SAYS which state it is in: entries, or the empty sentence.
  // Never a blank pane, which is indistinguishable from a failed read.
  const msgCount = await p.$$eval('[data-testid="ticket-thread"] [data-kind]', (els) => els.length);
  if (msgCount > 0) pass(`the thread renders (${msgCount} entries)`);
  else if (await p.$('text=No messages in this ticket yet'))
    pass('the thread renders its EMPTY state in words (0 entries — a state, not a blank pane)');
  else fail('thread renders', 'neither entries nor the empty state');

  if (!(await p.$('[data-testid="take-it"]'))) pass('«take it» is correctly ABSENT — the self-scoped queue only opens tickets that are already mine');
  else note('take-it is visible — this ticket is not assigned to the probe agent');

  // ── 3. a NOTE round-trips and renders as one ────────────────────────────────────────────────────
  const noteText = `internal ${Date.now().toString(36)}`;
  await p.$eval('[data-testid="composer-mode-note"]', (el) => el.click());
  await p.fill('[data-testid="composer-body"]', noteText);
  await p.$eval('[data-testid="composer-send"]', (el) => el.click());
  await p.waitForSelector(`text=${noteText}`, { timeout: 15000 });
  const noteKind = await p.$eval(
    `[data-testid="ticket-thread"] :text("${noteText}")`,
    (el) => el.closest('[data-kind]')?.getAttribute('data-kind'),
  ).catch(() => null);
  if (noteKind === 'note') pass('a private note round-tripped and renders AS a note (dom send)');
  else fail('note round-trip', `data-kind=${noteKind}`);

  // ── 4. a REPLY with a real FILE across the multipart edge (real click #2: send) ────────────────
  const replyText = `reply ${Date.now().toString(36)}`;
  await p.$eval('[data-testid="composer-mode-reply"]', (el) => el.click());
  await p.setInputFiles('[data-testid="composer-file-input"]', {
    name: 'w7-check.png',
    mimeType: 'image/png',
    buffer: PNG_1PX,
  });
  // ⚠️ The CHIP, not the block: the attachments block also renders the error line, and the first
  // run of this check passed on exactly that — an upload that had failed into an error message.
  await p.waitForSelector('[aria-label="Remove attachment w7-check.png"]', { timeout: 15000 });
  pass('the file crossed the multipart edge and holds a chip (uploadId in hand)');

  await p.fill('[data-testid="composer-body"]', replyText);
  await p.click('[data-testid="composer-send"]', { timeout: 12000 });
  await p.waitForSelector(`text=${replyText}`, { timeout: 15000 });
  const replyBlock = await p.$(`[data-testid="ticket-thread"] :text("${replyText}")`);
  const replyKind = replyBlock ? await replyBlock.evaluate((el) => el.closest('[data-kind]')?.getAttribute('data-kind')) : null;
  const hasAttachment = replyBlock
    ? await replyBlock.evaluate((el) => !!el.closest('[data-kind]')?.querySelector('a[href*="/api/uploads/"]'))
    : false;
  if (replyKind === 'reply') pass('the reply renders as a PUBLIC reply (real click on send)');
  else fail('reply kind', String(replyKind));
  if (hasAttachment) pass('the attachment rides the message and links to the uploads route');
  else fail('attachment in thread');

  // ── 5. «Submit as <status>» — one gesture, message then status ─────────────────────────────────
  // The target is picked to DIFFER from the current status — this check moves the same ticket on
  // every run, and submitting as the status it already holds would change nothing to assert.
  const target = statusBefore === 'In progress' ? 'Open' : 'In progress';
  const submitText = `closing ${Date.now().toString(36)}`;
  await p.fill('[data-testid="composer-body"]', submitText);
  await p.focus('[data-testid="composer-submit-as"]');
  await p.keyboard.press('Enter'); // the keyboard path — Radix guarantees it, and it is an a11y claim
  const targetItem = await p.waitForSelector(`[role="menuitem"]:has-text("Submit as ${target}")`, { timeout: 8000 });
  await targetItem.click();
  await p.waitForSelector(`text=${submitText}`, { timeout: 15000 });
  await p.waitForFunction(
    (want) => document.querySelector('[data-testid="ticket-status"]')?.textContent?.trim() === want,
    target,
    { timeout: 15000 },
  );
  pass(`«Submit as ${target}» sent the message AND moved the status («${statusBefore}» → «${target}»)`);

  // ── 6. tags attach and detach through the real registry ────────────────────────────────────────
  await p.focus('[data-testid="tag-add"]');
  await p.keyboard.press('Enter');
  const tagItem = await p.waitForSelector(`[role="menuitem"]:has-text("${TAG}")`, { timeout: 8000 });
  await tagItem.click();
  await p.waitForSelector(`[data-testid="ticket-tags"] :text("${TAG}")`, { timeout: 15000 });
  pass('the tag attached and renders on the ticket (keyboard menu + dom click)');

  await p.$eval(`[aria-label="Remove tag ${TAG}"]`, (el) => el.click());
  await p.waitForFunction(
    (tag) => !document.querySelector('[data-testid="ticket-tags"]')?.textContent?.includes(tag),
    TAG,
    { timeout: 15000 },
  );
  pass('the tag detached (dom) — the pair is idempotent server-side, so re-runs stay safe');

  // ── 7. W8 — the template inserts, the macro applies, the panel drags ────────────────────────────
  // (Same screen, next block: the two pickers ride the RE-GATED lists — crm.macros.use — so their
  // very presence for this agent proves the W8 permission move end to end.)
  await p.focus('[data-testid="composer-canned"]');
  await p.keyboard.press('Enter');
  const cannedItem = await p.waitForSelector('[role="menuitem"]:has-text("seed-greeting")', { timeout: 8000 });
  await cannedItem.click();
  const draft = await p.inputValue('[data-testid="composer-body"]');
  if (draft.includes('Thanks for reaching out')) pass('the template INSERTED its text into the draft (nothing was sent)');
  else fail('template insert', `draft: «${draft.slice(0, 60)}»`);
  await p.fill('[data-testid="composer-body"]', ''); // leave no accidental draft behind

  const statusBeforeMacro = ((await p.textContent('[data-testid="ticket-status"]')) ?? '').trim();
  await p.focus('[data-testid="composer-macro"]');
  await p.keyboard.press('Enter');
  const macroItem = await p.waitForSelector('[role="menuitem"]:has-text("seed-triage")', { timeout: 8000 });
  // Two seed macros share the prefix — pick the exact one (the other needs assign and may refuse).
  const macroName = await macroItem.textContent();
  if ((macroName ?? '').trim() !== 'seed-triage') {
    const exact = await p.$$('[role="menuitem"]');
    for (const item of exact) {
      if (((await item.textContent()) ?? '').trim() === 'seed-triage') { await item.click(); break; }
    }
  } else {
    await macroItem.click();
  }
  await p.waitForFunction(
    () => document.querySelector('[data-testid="ticket-status"]')?.textContent?.trim() === 'Pending',
    undefined,
    { timeout: 15000 },
  );
  pass(`the macro APPLIED server-side («${statusBeforeMacro}» → «Pending», the seed-triage bundle) — and its label landed in Tags`);

  // The drag — Шаг 1: the seam is the library's Resizable (react-resizable-panels), so the drag is
  // a REAL mouse drag on the handle (the library computes from absolute pointer coordinates — the
  // old synthetic-delta dispatch has nothing to talk to any more). Direction picked by HEADROOM:
  // the layout persists across runs as a PERCENTAGE (autoSaveId `crm.ticket.seam`), so a fixed +80
  // would pin against the 40% ceiling on repeat runs and assert movement where the constraint
  // correctly allows none.
  const widthBefore = await p.$eval('[data-testid="ticket-fields"]', (el) => el.parentElement.getBoundingClientRect().width);
  const groupWidth = await p.$eval('[data-testid="panel-divider"]', (el) => el.parentElement.getBoundingClientRect().width);
  const delta = widthBefore > groupWidth * 0.35 ? -80 : 80;
  const grip = await p.$eval('[data-testid="panel-divider"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await p.mouse.move(grip.x, grip.y);
  await p.mouse.down();
  await p.mouse.move(grip.x + delta, grip.y, { steps: 8 });
  await p.mouse.up();
  await p.waitForTimeout(300);
  const widthAfter = await p.$eval('[data-testid="ticket-fields"]', (el) => el.parentElement.getBoundingClientRect().width);
  const stored = await p.evaluate(() => window.localStorage.getItem('react-resizable-panels:crm.ticket.seam'));
  const moved = Math.abs(widthAfter - widthBefore - delta) <= 24 && Math.abs(widthAfter - widthBefore) >= 40;
  if (moved && stored)
    pass(`the panel drags and REMEMBERS (${Math.round(widthBefore)} → ${Math.round(widthAfter)}px; layout stored by the library) — real mouse`);
  else fail('panel resize', `${widthBefore} → ${widthAfter} (delta ${delta}), stored=${stored}`);

  // ── 8. W10 — the consolidated right rail, in the shell's own slot ───────────────────────────────
  const panel = await p.$('[data-testid="context-panel"]');
  if (panel) pass('the shell renders its context-panel slot — the rail is a REGION, not a page widget');
  else fail('context panel present');

  const railButtons = await p.$$eval('[aria-label="Context panels"] button', (bs) => bs.length);
  if (railButtons === 2) pass('⛔ exactly TWO rail buttons — Zendesk 3/4/5 are not built (R27)');
  else fail('two rail buttons', `found ${railButtons}`);

  // ⭐⭐ The standing anti-storm rule on W10's own key interaction: switching the panel. The slot
  // stores a NODE and the window pushes into it from an effect — the exact shape that looped in
  // jsdom before `setPanel`/`clear` were stabilised, so this is the assertion that would catch it
  // coming back in a browser, where a loop is a freeze rather than a hanging test.
  await assertNoRenderStorm({ page: p, selector: '[data-testid="panel-tab-active"]', pass, fail });

  const active = await p.$('[data-testid="active-tickets"]');
  const activeEmpty = await p.$('[data-testid="active-tickets-empty"]');
  if (active || activeEmpty)
    pass(`the Active tickets tab answers (${active ? 'has rows' : 'says it is empty, in words'})`);
  else fail('active tickets tab', 'neither a list nor its empty state');

  await p.$eval('[data-testid="rail-player"]', (el) => el.click());
  const card = (await p.$('[data-testid="player-card"]')) ?? (await p.$('[data-testid="player-card-unidentified"]'));
  if (card) pass('the player card renders (identity, or the honest "no player attached")');
  else fail('player card');
  const gr8 = await p.$eval('[data-testid="gr8-placeholder"]', (el) => el.textContent ?? '').catch(() => '');
  if (/GR8/.test(gr8) && /not hold this data yet|coming soon/i.test(gr8))
    pass('⭐ the GR8 block SAYS it is empty — a reserved slot, never a broken-looking blank');
  else if (await p.$('[data-testid="player-card-unidentified"]'))
    note('no GR8 block: this ticket has no player attached, so the card is in its other state');
  else fail('gr8 placeholder', gr8.slice(0, 60));

  await p.$eval('[data-testid="rail-kb"]', (el) => el.click());
  const kb = await p.$eval('[data-testid="kb-placeholder"]', (el) => el.textContent ?? '').catch(() => '');
  if (/not built yet/.test(kb)) pass('the Knowledge Base button admits the engine is not built (R19)');
  else fail('kb placeholder', kb.slice(0, 60));

  // ── 9. the way back ─────────────────────────────────────────────────────────────────────────────
  await p.$eval('[data-testid="ticket-back"]', (el) => el.click());
  await p.waitForSelector('[data-testid="bucket-rail"]', { timeout: 15000 });
  pass('← Inbox returns to the queue');

  if (errors.length === 0) pass('no uncaught page errors during the whole pass');
  else fail('page errors', errors[0]);
} catch (err) {
  fail('the interaction pass could not run', err instanceof Error ? err.message : String(err));
} finally {
  await browser.close().catch(() => {});
}

console.log(`\nW7 browser: ${ok} ok, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
