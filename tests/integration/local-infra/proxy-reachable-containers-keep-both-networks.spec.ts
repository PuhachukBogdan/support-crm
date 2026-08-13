import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * ⭐ **A CONTAINER THE SHARED PROXY MUST REACH NEEDS `edge` — AND STILL NEEDS `default`.**
 *
 * ── Why this guard exists ────────────────────────────────────────────────────────────────────────
 * The reverse proxy in front of the hosted stand is **not part of this compose project** — it fronts
 * several unrelated projects on one host — so it can only reach a container that shares the external
 * `edge` network with it. Two containers are reachable by design: `web` (the app) and, since feature
 * 034, `gateway` (the realtime socket, because Next.js does not proxy a WebSocket upgrade and `/ws`
 * therefore goes straight to the gateway).
 *
 * Both halves of that sentence failed live, in the same afternoon, in opposite directions:
 *
 *   · **Missing `edge`.** The proxy's `/ws` route pointed at `crm-gateway-1:3000`, the gateway was on
 *     `default` only, and every upgrade came back **502**. Nothing in the repo was wrong and no test
 *     could go red: the defect lived in the gap between a routing table outside the repo and a
 *     network list inside it. Symptom-wise this is indistinguishable from the *previous* failure on
 *     the same path (a 401 from the outer basic auth), which is what made it cost a round trip.
 *
 *   · **`edge` INSTEAD OF `default`.** This is the trap: in compose, adding a `networks:` key to a
 *     service **replaces** its implicit `default` membership rather than adding to it. Writing just
 *     `- edge` leaves the gateway able to talk to the proxy and unable to resolve `auth:50051`,
 *     `chats:50053` or `redis` — every gRPC call and the realtime subscription break at once, while
 *     the container itself starts cleanly and answers HTTP.
 *
 * ── What it asserts ─────────────────────────────────────────────────────────────────────────────
 * The two proxy-reachable services name **both** networks, and `edge` is declared external (created
 * by the proxy, not by us). Scoped to those two on purpose: every other service must stay off `edge`,
 * so the list is asserted as an exact set — a third service appearing on the shared network is a
 * widening of the blast radius that should be a deliberate edit to this file, not a silent diff.
 */
const ROOT = resolve(__dirname, '..', '..', '..');
const compose = readFileSync(join(ROOT, 'compose.yaml'), 'utf8').replace(/\r\n/g, '\n');

/**
 * Reachable by the shared proxy, and why. Everything else must NOT be on `edge`.
 *
 * ⚠️ `mailpit` is on this list and is the reason the outer basic auth can never be dropped wholesale:
 * the published mailbox carries live one-time login codes (SEC-42), so its lock is unconditional. The
 * `/ws` exemption applies to the app's site block only.
 */
const PROXY_REACHABLE: Record<string, string> = {
  web: 'the app itself — the only way in, TLS terminated by the proxy',
  gateway: 'the realtime socket: /ws cannot be proxied through Next.js (feature 034)',
  mailpit: 'the stand mailbox, published so a live round can read mail in a browser',
};

/**
 * The `networks:` list inside one service block, or `null` when the block has none (= implicit
 * `default` only). Comments are stripped first: this file explains networks in prose at length, and a
 * guard satisfied by a comment passes the moment somebody documents the membership they removed.
 */
function networksOf(service: string): string[] | null {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  expect(start).toBeGreaterThan(-1);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}\S/.test(l));
  const block = (end === -1 ? rest : rest.slice(0, end)).map((l) => l.replace(/#.*$/, ''));

  const at = block.findIndex((l) => /^ {4}networks:\s*$/.test(l));
  if (at === -1) return null;
  const items: string[] = [];
  for (const line of block.slice(at + 1)) {
    const m = /^ {6}- (\S+)\s*$/.exec(line);
    if (!m) break;
    items.push(m[1]);
  }
  return items;
}

/** Every service block in compose, so "everything else" below is a real sweep and not a short list. */
function allServices(): string[] {
  const body = compose.slice(compose.indexOf('\nservices:'));
  const upTo = body.slice(0, body.search(/\n(volumes|networks):/));
  return [...upTo.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]);
}

describe('containers the shared reverse proxy reaches', () => {
  it.each(Object.entries(PROXY_REACHABLE))('%s is on `edge` (%s)', (service) => {
    expect(networksOf(service)).toContain('edge');
  });

  // The trap: `networks:` REPLACES the implicit default. Losing it costs every sibling by name.
  it.each(Object.keys(PROXY_REACHABLE))('%s keeps `default`, so siblings stay resolvable', (service) => {
    expect(networksOf(service)).toContain('default');
  });

  it('nothing else joins the shared network', () => {
    const onEdge = allServices().filter((s) => networksOf(s)?.includes('edge'));
    expect(onEdge.sort()).toEqual(Object.keys(PROXY_REACHABLE).sort());
  });

  // Positive control: the sweep above must actually be sweeping. If `allServices()` silently returned
  // few or no names, the exact-set assertion could only fail, never pass vacuously — but this pins the
  // parse itself, which is the part that quietly rots when compose is reformatted.
  it('the sweep sees the whole file', () => {
    const services = allServices();
    expect(services).toContain('gateway');
    expect(services).toContain('worker');
    expect(services.length).toBeGreaterThanOrEqual(8);
  });

  it('`edge` is external — the proxy creates it, we only join it', () => {
    expect(compose).toMatch(/^ {2}edge:\n {4}external: true$/m);
  });
});
