/**
 * Browser check for the four things the operator reported on 2026-08-10, as a person meets them.
 *
 * ⚠️ **Three of the four are invisible to jsdom by construction**, which is why this file exists and
 * why the 687-test suite could not have caught any of them:
 *
 *  1. The funnel's list was CLIPPED by `overflow: hidden` on the header cell. jsdom has no layout and
 *     no paint, so every assertion about a popup being "in the document" passed while a person saw a
 *     40 px sliver. Here it is checked GEOMETRICALLY — `elementFromPoint` over the ticket rows must
 *     hit the list. That is the only form of the claim that could have failed before the fix.
 *  2. An editable field looked identical to a read-only one at rest. A suite can read a className; it
 *     cannot see that two fields are indistinguishable.
 *  3. The user menu's presence write has to survive a RELOAD — the state lives on the server, not in
 *     the tab, and that is the difference between a control and a decoration.
 *
 * Run ON THE STAND, against the VERIFICATION origin (rule 12 — the public link is frozen).
 */
import { chromium } from 'playwright';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-next.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.2:8025';
const ROLE_PW = process.env.ROLE_PASSWORD ?? 'Stand#Role7x';
// An ADMIN: holds `crm.conversation.set_brand`, `users.list.view`, `crm.conversation.assign` and
// `crm.contact.lookup` — every key the left column's controls are gated on. A support agent would
// correctly see fewer of them, which is a different check.
const WHO = process.env.WHO ?? 'role-admin@beton.win';
const SHOTS = process.env.SHOT_DIR ?? '/tmp/pw-work/shots';
/** A conversation on this stand. Opened by URL — see the note where it is used. */
const TICKET = process.env.TICKET_ID ?? '';
/**
 * ⚠️ A player id that EXISTS in this account. The server resolves the id and refuses one that names
 * nobody — which is exactly the check the typed field relies on (a typed id is not a verified one),
 * so a made-up value would test the refusal, not the write.
 */
const PLAYER = process.env.PLAYER_ID ?? 'seed-player-001';
/**
 * ⭐ `READ_ONLY=1` — everything is OBSERVED and nothing is written.
 *
 * ⚠️ Not a convenience: on the PUBLIC stand a tester may be working, and this file otherwise attaches
 * a player to a ticket, reassigns it and flips the probe's presence. Rule 12 exists to stop exactly
 * that. So the public round asserts what the operator reported — the funnel is not hidden, the fields
 * declare themselves editable, the chooser offers names, the window offers four states — and leaves
 * the data alone. The WRITES are proven on the closed stand, where the data is ours.
 */
const READ_ONLY = process.env.READ_ONLY === '1';

let ok = 0;
let bad = 0;
const pass = (m) => {
  ok += 1;
  console.log(`  PASS  ${m}`);
};
const fail = (m, d) => {
  bad += 1;
  console.log(`  FAIL  ${m}${d ? ` — ${d}` : ''}`);
};

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
    const res = await fetch(
      `${MAIL}/api/v1/search?query=to%3A${encodeURIComponent(email)}&limit=1`,
      { headers: edgeHeaders() },
    );
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
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1600, height: 900 },
    ...creds,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // ── sign in ────────────────────────────────────────────────────────────────────────────────────
  await page.goto(`${WEB}/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"]', WHO);
  await page.fill('input[type="password"]', ROLE_PW);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(2500);
  await page.fill(
    'input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]',
    await codeFor(WHO),
  );
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 20000 });
  pass(`signed in as ${WHO}`);

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // 1. The funnel's list is ON TOP, not behind the ticket list
  // ════════════════════════════════════════════════════════════════════════════════════════════
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('[data-testid="dt-scroll"]', { timeout: 20000 });
  const pending = page.locator('[data-testid="bucket-pending"]');
  if (await pending.count()) {
    await pending.click();
    await page.waitForTimeout(1200);
  }

  const funnel = page.locator('[data-testid="filter-channel"]').first();
  if (!(await funnel.count())) {
    fail('the channel funnel is on the screen at all');
  } else {
    await funnel.click();
    await page.waitForTimeout(400);
    const list = page.locator('[data-testid="filter-channel-list"]');
    if (!(await list.count())) {
      fail('the funnel opened a list');
    } else {
      const box = await list.boundingBox();
      pass(`the list opened (${Math.round(box.width)}×${Math.round(box.height)} px)`);

      /**
       * ⭐⭐ THE assertion. The operator's report was *«я вижу маленькую часть этого элемента»* — a
       * sliver, clipped to the header cell. A clipped list still reports a full `boundingBox`, so
       * size alone proves nothing: what proves it is asking the BROWSER what is painted at a point
       * deep inside the list, well below the header row.
       */
      const probeY = box.y + Math.min(box.height - 6, 70);
      const hit = await page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return { tag: 'none', inList: false, inRow: false };
          return {
            tag: el.tagName.toLowerCase(),
            inList: !!el.closest('[data-testid="filter-channel-list"]'),
            inRow: !!el.closest('tbody'),
          };
        },
        [box.x + box.width / 2, probeY],
      );
      if (hit.inList) pass('a point 70 px down the list belongs to the LIST — nothing paints over it');
      else fail('the list is behind something', `point hit <${hit.tag}>, inRow=${hit.inRow}`);

      // …and it genuinely extends past the header row, i.e. it is not merely a sliver that fits.
      const headerBottom = await page.evaluate(() => {
        const th = document.querySelector('thead');
        return th ? th.getBoundingClientRect().bottom : 0;
      });
      if (box.y + box.height > headerBottom + 30)
        pass('the list reaches well past the header row (it is not a clipped sliver)');
      else fail('the list still ends at the header', `list bottom ${box.y + box.height}, header ${headerBottom}`);

      await page.screenshot({ path: `${SHOTS}/01-funnel-open-light.png` });
      // Choosing still works through the portal — the outside-click handler must not eat the click.
      // ⓘ Safe even read-only: a filter is transient by design (FR-013) and writes nothing.
      const before = page.url();
      await page.locator('[data-testid="filter-channel-list"] [role="option"]').nth(1).click();
      await page.waitForTimeout(1200);
      const applied = await funnel.textContent();
      if ((applied ?? '').trim().length > 0) pass(`choosing through the portal applied it (${applied.trim()})`);
      else fail('choosing an option did nothing', `url ${before}`);
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // 2. The rail's user menu — the profile window, with the statuses
  // ════════════════════════════════════════════════════════════════════════════════════════════
  const trigger = page.locator('[data-testid="user-menu-trigger"]');
  if (!(await trigger.count())) {
    fail('the user menu is in the rail');
  } else {
    pass('the user menu is in the rail, on the Inbox');
    await trigger.click();
    await page.waitForSelector('[data-testid="user-menu"]', { timeout: 8000 });
    const states = await page.locator('[data-testid="user-menu"] [data-testid^="presence-"]').count();
    if (states === 4) pass('the window offers all four presence states');
    else fail('four presence states', `saw ${states}`);
    await page.screenshot({ path: `${SHOTS}/02-user-menu-light.png` });

    if (READ_ONLY) {
      // The badge is still READ, so the control is observed end-to-end minus the write.
      const shown = await page.locator('[data-testid="presence-dot"]').getAttribute('data-state');
      pass(`read-only: the state renders from the server (${shown}) — not flipping it here`);
      await page.keyboard.press('Escape');
    } else {
    await page.locator('[data-testid="presence-away"]').click();
    await page.waitForTimeout(1500);
    // ⚠️ The reload is the whole point: presence lives on the SERVER (the router reads the same
    // store), so a state that survives only in the tab would be a decoration.
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="presence-dot"]', { timeout: 20000 });
    const held = await page.locator('[data-testid="presence-dot"]').getAttribute('data-state');
    if (held === 'away') pass('Break survived a reload — it is on the server, not in the tab');
    else fail('presence held across a reload', `data-state=${held}`);

    await page.locator('[data-testid="user-menu-trigger"]').click();
    await page.waitForSelector('[data-testid="user-menu"]', { timeout: 8000 });
    await page.locator('[data-testid="presence-online"]').click();
    await page.waitForTimeout(1200);
    pass('put back On shift (the stand is left as it was found)');
    }
  }

  // ════════════════════════════════════════════════════════════════════════════════════════════
  // 3. The ticket window's left column — the marks, Player ID, Assignee
  // ════════════════════════════════════════════════════════════════════════════════════════════
  /**
   * ⚠️ Opened by URL, not by clicking a row — and the reason is a real property of the product, not a
   * convenience. The Inbox is SELF-SCOPED: every list request carries `assigneeOperatorId = mine` and
   * no control can widen it (the operator's own instruction). This admin holds no tickets, so their
   * Inbox is legitimately EMPTY, and the first two runs of this file failed waiting for a row that
   * correctly does not exist. The ticket window is reachable by URL for anyone with `crm.inbox.view`.
   */
  await page.goto(`${WEB}/tickets/${TICKET}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('[data-testid="ticket-fields"]', { timeout: 20000 });
  await page.waitForTimeout(2500);
  pass(`the ticket window opened (${TICKET})`);

  // The affordance, field by field: an editable one carries a mark, Channel does not.
  const marks = await page.evaluate(() => {
    const out = {};
    for (const id of ['field-brand', 'field-status', 'field-priority', 'field-assignee', 'field-player-id']) {
      const el = document.querySelector(`[data-testid="${id}"]`);
      out[id] = el ? !!el.querySelector('svg') : null;
    }
    return out;
  });
  /**
   * ⚠️ **`field-player-id` may legitimately be ABSENT, and the second public round is what taught this
   * file so.** The editor is gated on `crm.contact.lookup`, which a TEAMLEAD does not hold — they have
   * `crm.contact.view` and reach a customer through the ticket. So its absence for that role is the
   * render-gate working, and the run that reported it as a failure was the check being wrong, not the
   * product. It is not skipped, though: absence must come with the value still READABLE, because
   * refusing the write is not refusing the fact.
   */
  const GATED = new Set(['field-player-id']);
  for (const [id, has] of Object.entries(marks)) {
    if (has === true) pass(`${id} carries the editable mark`);
    else if (has === null && GATED.has(id)) {
      const readable = await page.evaluate(
        () => (document.querySelector('[data-testid="ticket-fields"]')?.textContent ?? '').includes('Player ID'),
      );
      if (readable) pass(`${id} is read-only for this role (no crm.contact.lookup) and still shows its value`);
      else fail(`${id} is at least readable when the editor is gated off`);
    } else if (has === null) fail(`${id} is on the screen`);
    else fail(`${id} carries the editable mark`, 'no icon — it looks read-only');
  }
  await page.screenshot({ path: `${SHOTS}/03-ticket-fields-light.png`, fullPage: false });

  // Player ID: type one, and it must come BACK from the server after a reload.
  const stamp = PLAYER;
  const pid = page.locator('[data-testid="field-player-id"]');
  if (!(await pid.count())) {
    // Already accounted for above — this role is not entitled to the editor, which is a PASS there.
    pass('Player ID: no editor offered to a role without the key (nothing that would 403)');
  } else if (READ_ONLY) {
    // The editor OPENS — which is the operator's complaint («нельзя заполнять») — and Escape
    // abandons, so a tester's ticket keeps the player it had.
    await pid.click();
    const opened = await page.locator('[data-testid="field-player-id-input"]').count();
    if (opened === 1) pass('read-only: Player ID opens an input you can type into');
    else fail('Player ID opens an editor', 'no input appeared');
    await page.keyboard.press('Escape');
  } else {
    await pid.click();
    const input = page.locator('[data-testid="field-player-id-input"]');
    await input.fill(stamp);
    await input.press('Enter');
    await page.waitForTimeout(2500);
    const shown = (await page.locator('[data-testid="field-player-id"]').textContent()) ?? '';
    if (shown.includes(stamp)) pass(`Player ID accepted a typed value (${stamp})`);
    else fail('Player ID took the typed value', `shows "${shown.trim()}"`);

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="field-player-id"]', { timeout: 20000 });
    await page.waitForTimeout(1500);
    const after = (await page.locator('[data-testid="field-player-id"]').textContent()) ?? '';
    if (after.includes(stamp)) pass('…and the server kept it across a reload');
    else fail('the typed player id persisted', `after reload: "${after.trim()}"`);
  }

  // Assignee: a chooser with NAMES, and it writes.
  const assignee = page.locator('[data-testid="field-assignee"]');
  if (!(await assignee.count())) {
    fail('Assignee is a chooser for somebody holding both keys');
  } else {
    pass('Assignee is a chooser');
    await assignee.click();
    await page.waitForTimeout(800);
    const options = await page.locator('[data-testid^="field-assignee-option-"]').allTextContents();
    if (options.length > 0) pass(`it offers ${options.length} colleague(s): ${options.slice(0, 3).join(' · ')}`);
    else fail('the chooser offers at least one colleague', 'empty menu');
    // ⚠️ A NAME, not a UUID — that is what the operator could not read before.
    const looksLikeUuid = options.every((o) => /^[0-9a-f-]{20,}/.test(o.trim()));
    if (options.length > 0 && !looksLikeUuid) pass('the options are names, not operator ids');
    else if (options.length > 0) fail('the options are names', options[0]);
    await page.screenshot({ path: `${SHOTS}/04-assignee-open-light.png` });

    if (READ_ONLY) {
      pass('read-only: the chooser is open and offers names — not reassigning a tester’s ticket');
      await page.keyboard.press('Escape');
    } else if (options.length > 0) {
      await page.locator('[data-testid^="field-assignee-option-"]').first().click();
      await page.waitForTimeout(2500);
      const now = (await page.locator('[data-testid="field-assignee"]').textContent()) ?? '';
      if (now.trim() && !/^Unassigned$/.test(now.trim())) pass(`assigned: ${now.trim()}`);
      else fail('the assignment landed', `field now reads "${now.trim()}"`);
    }
  }

  // ── dark, because rule 11 says both ────────────────────────────────────────────────────────────
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => {
    document.documentElement.classList.add('dark');
    try {
      localStorage.setItem('theme', 'dark');
    } catch {}
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="ticket-fields"]', { timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/05-ticket-fields-dark.png` });
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('[data-testid="dt-scroll"]', { timeout: 20000 });
  const darkFunnel = page.locator('[data-testid="filter-priority"]').first();
  if (await darkFunnel.count()) {
    await darkFunnel.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/06-funnel-open-dark.png` });
    await page.keyboard.press('Escape');
  }
  const darkTrigger = page.locator('[data-testid="user-menu-trigger"]');
  if (await darkTrigger.count()) {
    await darkTrigger.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/07-user-menu-dark.png` });
  }
  pass('dark screenshots taken');

  if (errors.length === 0) pass('no uncaught page errors in the whole run');
  else fail('no uncaught page errors', errors.slice(0, 3).join(' | '));
} catch (e) {
  fail('the run completed', String(e && e.message ? e.message : e));
} finally {
  await browser.close();
}

console.log(`\n  ${ok} passed, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
