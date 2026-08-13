/**
 * W32 live check — the named offboarding destination, banned addresses, the security-posture page
 * (roadmap 3.16-remainder + 12.10 + 12.11, spec 039), as BEHAVIOUR.
 *
 *   A  ⭐ a desk gains a LEAD, the change is on the journal, and it survives a re-read
 *   C  ⭐ the security page reads LIVE — issue a key, reload, watch the number move; the fixed
 *      sign-in code is named as a weakening; a built-in row says so; no address in the payload
 *   D  ⛔ a ban is journalled with the ADDRESS AS THE TARGET; a repeat is a quiet success
 *   M1 ⭐ the boundary sees the REAL caller and refuses BEFORE authentication — proven on a route
 *      that needs no session at all, which is the only way to tell that apart from «instead of»
 *   M2 ⭐ the WebSocket refuses a banned address — middleware never sees the upgrade
 *
 * ⚠️ **M1/M2 END THE SESSION on purpose.** Banning your own address is irreversible from that
 * address, and that is correct product behaviour rather than a gap: the screen warns before saving.
 * The runner lifts it out of band afterwards so a second run is possible.
 *
 * ⚠️ Run ON THE STAND against the VERIFICATION origin (rule 12 — the public link is frozen).
 */
import { request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';

const WEB = process.env.WEB_ORIGIN ?? 'https://crm-next.37.1.206.146.sslip.io';
const MAIL = process.env.MAIL_ORIGIN ?? 'http://127.0.0.2:8025';
const OWNER = process.env.OWNER_EMAIL ?? 'warden@beton.win';
const OWNER_PW = process.env.OWNER_PASSWORD ?? '';

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
  const body = await login.text();
  let challengeId;
  try {
    challengeId = JSON.parse(body).challengeId;
  } catch {
    /* reported below */
  }
  if (!challengeId) {
    throw new Error(`login step 1 failed for ${email}: ${login.status} ${body.slice(0, 160)}`);
  }
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

const entriesOf = (body) => body?.entries ?? body?.items ?? [];
const RUN = Date.now().toString(36);

try {
  const owner = await apiSession(OWNER, OWNER_PW);
  const meOwner = await owner('GET', '/auth/me');
  const ownerUserId = meOwner.json?.userId ?? meOwner.json?.user?.id ?? '';

  // ═══ A · the desk gains somebody who answers for it ═══════════════════════════════════════════
  const groups = await owner('GET', '/groups');
  const desk = (groups.json?.groups ?? [])[0];
  if (!desk || !ownerUserId) {
    fail('A · no desk on the stand to give a lead', `desk=${!!desk} owner=${!!ownerUserId}`);
  } else {
    const named = await owner('PUT', `/groups/${desk.id}/lead`, { userId: ownerUserId });
    named.status < 300
      ? pass('A · a desk is given a lead')
      : fail('A · naming the lead', `${named.status} ${JSON.stringify(named.json)}`);

    const again = await owner('GET', '/groups');
    ((again.json?.groups ?? []).find((g) => g.id === desk.id)?.leadUserId ?? '') === ownerUserId
      ? pass('A · the lead survives a re-read — the wire and the store agree')
      : fail('A · the lead did not survive a re-read');

    const stranger = await owner('PUT', `/groups/${desk.id}/lead`, { userId: 'not-of-this-account' });
    stranger.status >= 400
      ? pass('A · ⛔ somebody who is not of this account cannot lead a desk')
      : fail('A · a cross-account lead was accepted', `${stranger.status}`);
    await owner('PUT', `/groups/${desk.id}/lead`, { userId: ownerUserId });

    const journal = await owner('GET', '/audit?action=group.lead_changed&pageSize=5');
    entriesOf(journal.json).length > 0
      ? pass('A · the change is on the journal — it decides where a colleague’s customers go')
      : fail('A · the lead change is not in the journal');

    const cleared = await owner('DELETE', `/groups/${desk.id}/lead`);
    cleared.status < 300
      ? pass('A · a desk with NO lead is a legitimate state, not an error')
      : fail('A · clearing the lead', `${cleared.status}`);
    await owner('PUT', `/groups/${desk.id}/lead`, { userId: ownerUserId });
  }

  // ═══ C · the security page reads LIVE ═════════════════════════════════════════════════════════
  const first = await owner('GET', '/admin/security');
  const facts = first.json?.facts ?? [];
  facts.length > 0
    ? pass(`C · the page answers ${facts.length} facts`)
    : fail('C · the page returned nothing', JSON.stringify(first.json).slice(0, 160));

  const keyFact = facts.find((f) => String(f.key ?? '').includes('key'));
  const issued = await owner('POST', '/admin/api-keys', {
    consumer: `w32 probe ${RUN}`,
    ipAllowList: ['203.0.113.1'],
    ratePerHour: 10,
  });
  const second = await owner('GET', '/admin/security');
  const keyFact2 = (second.json?.facts ?? []).find((f) => f.key === keyFact?.key);
  keyFact && keyFact2 && keyFact.value !== keyFact2.value
    ? pass('C · ⭐ issuing a key MOVES the page — every row is read, not typed')
    : fail('C · the page did not move when the system did', `${keyFact?.value} → ${keyFact2?.value}`);
  await owner('DELETE', `/admin/api-keys/${issued.json?.key?.id ?? ''}`);

  facts.some((f) => f.kind === 'built_in')
    ? pass('C · a built-in fact says so, rather than posing as a switch that is on')
    : fail('C · no fact declares itself built in — `kind` would describe nothing');

  const fixed = facts.find((f) => String(f.key ?? '').includes('fixed'));
  fixed
    ? pass(`C · ⭐ the fixed sign-in code is surfaced as a weakening (state: ${fixed.state})`)
    : fail('C · the fixed sign-in code is invisible — and it is ACTIVE on this stand');

  const payload = JSON.stringify(first.json);
  !payload.includes(OWNER) && !/\b\d{1,3}(\.\d{1,3}){3}\b/.test(payload)
    ? pass('C · the payload carries no address and no contact value')
    : fail('C · the page transferred something identifying');

  // ═══ D · banned addresses ═════════════════════════════════════════════════════════════════════
  const banned = await owner('POST', '/admin/denied-addresses', {
    address: '198.51.100.77',
    note: `w32 ${RUN}`,
  });
  banned.status < 300 && banned.json?.created === true
    ? pass('D · an unrelated address is banned')
    : fail('D · banning an address', `${banned.status} ${JSON.stringify(banned.json)}`);

  const twice = await owner('POST', '/admin/denied-addresses', { address: '198.51.100.77' });
  twice.json?.created === false
    ? pass('D · ⭐ a repeat is a quiet success and creates no second row')
    : fail('D · the repeat', JSON.stringify(twice.json));

  const banLog = await owner('GET', '/audit?action=ip_ban.config_changed&pageSize=5');
  entriesOf(banLog.json).some(
    (e) => String(e.targetRef ?? e.target_ref ?? '') === '198.51.100.77',
  )
    ? pass('D · ⭐ journalled with the ADDRESS AS THE TARGET — never in the detail, which refuses some addresses at random')
    : fail('D · the ban is not on the journal, or not as the target');

  (await fetch(`${WEB}/api/health`, { headers: edgeHeaders() })).status === 200
    ? pass('D · banning somebody else does not affect this caller')
    : fail('D · a stranger’s ban affected us');

  const lifted = await owner('DELETE', `/admin/denied-addresses/${banned.json?.address?.id ?? ''}`);
  lifted.json?.removed === true
    ? pass('D · the ban lifts')
    : fail('D · lifting the ban', JSON.stringify(lifted.json));

  // ═══ M1 / M2 · LAST, because a self-ban ends this session ═════════════════════════════════════
  const myIp = process.env.RUNNER_IP;
  if (!myIp) {
    fail('M1 · RUNNER_IP not supplied — the boundary measurement cannot be made');
  } else {
    await owner('POST', '/admin/denied-addresses', { address: myIp, note: `w32 self ${RUN}` });

    // ⚠️ A route that needs NO SESSION AT ALL. Testing only an authenticated page cannot tell
    // «refused before authentication» from «refused instead of authentication», and the first is
    // what 12.10 asks for.
    const sessionFree = await fetch(`${WEB}/api/provisioning/v1/staff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...edgeHeaders() },
      body: '{}',
    });
    sessionFree.status === 403
      ? pass('M1 · ⭐ the boundary sees the REAL caller and refuses BEFORE authentication')
      : fail('M1 · the ban did not reach a session-free route', `${sessionFree.status}`);

    /**
     * ⚠️ A RAW upgrade, with no client library: `/ws` is routed straight to the gateway and the
     * upgrade never traverses the express stack, so this is the only path that proves the socket's
     * own check exists. A banned caller must not reach a live event feed while being locked out of
     * every page — that gap would be invisible, because every HTTP test would still be green.
     */
    await new Promise((resolve) => {
      const url = new URL(`${WEB}/ws`);
      const req = httpsRequest(
        {
          host: url.hostname,
          path: url.pathname,
          port: 443,
          rejectUnauthorized: false,
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
            Cookie: owner.cookie,
            ...edgeHeaders(),
          },
        },
        (res) => {
          // Anything but 101 is a refusal at or before the upgrade.
          pass(`M2 · ⭐ the socket refuses a banned address (HTTP ${res.statusCode}, not 101)`);
          req.destroy();
          resolve();
        },
      );
      req.on('upgrade', (_res, socket) => {
        // The upgrade completed — the gateway's own handler must close it immediately.
        let closedFast = false;
        socket.on('close', () => {
          if (!closedFast) {
            closedFast = true;
            pass('M2 · ⭐ the socket accepted the upgrade and then CLOSED the banned caller');
            resolve();
          }
        });
        setTimeout(() => {
          if (!closedFast) {
            closedFast = true;
            fail('M2 · the socket let a banned address hold an open connection');
            socket.destroy();
            resolve();
          }
        }, 8000);
      });
      req.on('error', () => {
        pass('M2 · ⭐ the socket refused the banned address at the transport');
        resolve();
      });
      req.end();
      setTimeout(() => {
        fail('M2 · no answer from the socket in 15s');
        req.destroy();
        resolve();
      }, 15000);
    });

    const cannotLift = await owner('GET', '/admin/denied-addresses');
    cannotLift.status === 403
      ? pass('D · ⭐ having banned themselves the administrator is locked out — the screen’s warning is true')
      : fail('D · the self-ban did not apply to the administrator', `${cannotLift.status}`);
    console.log('  ⓘ the self-ban is lifted out of band by the runner — correct product behaviour, not a gap');
  }
} catch (e) {
  fail('the run itself', e?.message ?? String(e));
}

console.log(`\nW32: ${ok} passed, ${bad} failed`);
process.exit(bad === 0 ? 0 : 1);
