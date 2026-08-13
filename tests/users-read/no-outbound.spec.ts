import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/**
 * T049 + T049a (feature 018, roadmap 5.1) — **FR-026: this feature reaches nothing outward.**
 * **FR-027: it exposes no way to change a record.**
 *
 * ── Why "it reads, obviously it doesn't write" is not good enough ─────────────────────────────────
 * Both properties are stated as absences, and an absence is exactly what a normal test cannot observe:
 * every scenario passes on a read API that ALSO has a write path, and every scenario passes on one that
 * quietly calls GR8. The requirement is about what is *not* reachable, so the assertion has to be a scan.
 *
 * ── The specific outward call this forbids, and why it is tempting ───────────────────────────────
 * `Player.gr8_snapshot` is a cache seam: a blob some future worker fills (roadmap 7.4) and a later read
 * layer projects (5.4). Serving a card whose snapshot is empty invites exactly one shortcut — "fetch it
 * now, it's one call". That shortcut would: put a synchronous third-party call inside a customer read
 * (ADR 0029 forbids it), make the read's latency GR8's to decide, and burn a rate limit nobody has
 * measured (7.6). It also cannot work today — we hold no GR8 credential at all — so it would fail closed
 * in a way that looks like our bug. The absence is the design; here it is asserted.
 *
 * ── And the write surface ────────────────────────────────────────────────────────────────────────
 * Editing a portfolio, an AM note or an assignment are real features with real requirements (roadmap 5.5 /
 * 5.7), each needing its own permission key, its own audit action and — for the assignment — an
 * abnormal-volume alert, because self-assignment grants access. A write bolted onto this read API would
 * arrive with none of that. So a mutation must be *absent*, not merely unimplemented.
 */
const ROOT = resolve(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'gen' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

const rel = (p: string) => p.slice(ROOT.length + 1).split(sep).join('/');

function codeOf(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

/** Every production file this feature added or touched. */
const READ_PATH_DIRS = [
  'services/users/src/player',
  'services/users/src/operator',
  'services/gateway/src/players',
  'libs/common/src/paging',
];

const readPath = READ_PATH_DIRS.flatMap((d) => walk(join(ROOT, ...d.split('/'))));

describe('the scan sees the feature (guards against a vacuous pass)', () => {
  it('covers the owning service, the edge and the shared cursor', () => {
    const paths = readPath.map(rel);
    expect(paths).toContain('services/users/src/player/player.grpc.controller.ts');
    expect(paths).toContain('services/users/src/player/player.repository.ts');
    expect(paths).toContain('services/users/src/operator/operator.repository.ts');
    expect(paths).toContain('services/gateway/src/players/players.controller.ts');
    expect(paths).toContain('libs/common/src/paging/keyset.ts');
    expect(readPath.length).toBeGreaterThan(8);
  });
});

describe('*** FR-026: nothing on the read path reaches outward ***', () => {
  const OUTBOUND = [
    'axios',
    'node-fetch',
    'undici',
    'got',
    'superagent',
    'http.request',
    'https.request',
    'graphql-request',
    '@apollo/client',
    'nodemailer',
    '@aws-sdk',
    'S3Client',
    'WebSocket',
  ];

  it.each(OUTBOUND)('no read-path file reaches for %s', (marker) => {
    const offenders = readPath
      .filter((f) => codeOf(f).toLowerCase().includes(marker.toLowerCase()))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('no bare fetch() call either', () => {
    // `fetch` is global in Node 22, so an outbound call needs no import — which makes the import scan
    // above insufficient on its own. This is the assertion that would actually catch the shortcut.
    const offenders = readPath.filter((f) => /\bfetch\s*\(/.test(codeOf(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  /**
   * ⚠️ The naive form of this assertion — "no read-path file mentions GR8 in code" — is WRONG, and it
   * failed on the first run for the right reason: `player.repository.ts` declares the row's type, and the
   * row has `gr8_snapshot` / `gr8_fetched_at` / `gr8_stale` columns. Naming a column you select is not
   * reaching for a third party. The requirement is that no GR8 **call** exists, so that is what is scanned:
   * a host, a client, or a credential. The column names are then pinned separately, so a *fourth* kind of
   * GR8 reference cannot slip in under the cover of "it's just the column".
   */
  const GR8_COLUMNS = ['gr8_snapshot', 'gr8_fetched_at', 'gr8_stale'];

  it('*** no read-path file can CALL GR8 *** (no host, no client, no credential)', () => {
    const CALL_SHAPED = [
      /gr8\.tech/i,
      /cenv-eu\.tech/i,
      /dwh-(prod|stage)/i,
      /\bGr8\w*(Client|Service|Api|Connector)\b/,
      /\b(fetch|get|call|query)Gr8\w*/i,
      /X-Api-Key|X-Brand|X-Operator-Id/i,
      /process\.env\.GR8/,
    ];
    for (const pattern of CALL_SHAPED) {
      const offenders = readPath.filter((f) => pattern.test(codeOf(f))).map(rel);
      expect({ pattern: String(pattern), offenders }).toEqual({
        pattern: String(pattern),
        offenders: [],
      });
    }
  });

  it('every GR8 reference on the read path is one of the three COLUMNS, nothing else', () => {
    const mentions = readPath.flatMap((f) =>
      [...codeOf(f).matchAll(/\bgr8_?\w*/gi)].map((m) => ({ file: rel(f), token: m[0] })),
    );
    // Non-empty on purpose: the seam is genuinely read here, and an empty result would mean the scan is
    // looking at the wrong files rather than that the property holds.
    expect(mentions.length).toBeGreaterThan(0);
    for (const { file, token } of mentions) {
      expect({ file, token, known: GR8_COLUMNS.includes(token) }).toEqual({
        file,
        token,
        known: true,
      });
    }
  });

  it('the snapshot is never projected or decoded here — it stays opaque (roadmap 5.4 owns that)', () => {
    // Typing the blob is the 5.4 projection, and doing a little of it here is how the two distinct empty
    // states ("not cached yet" vs "outside the 180-day window") get collapsed into one wrong answer.
    for (const f of readPath) {
      const source = codeOf(f);
      expect({ file: rel(f), decodes: /gr8_snapshot\s*(?:\.|\[|as\s+\{)/.test(source) }).toEqual({
        file: rel(f),
        decodes: false,
      });
      expect({ file: rel(f), parses: /JSON\.parse\s*\(\s*\w*gr8/i.test(source) }).toEqual({
        file: rel(f),
        parses: false,
      });
    }
  });

  it('no read-path file reads an external base URL or credential from configuration', () => {
    // A destination arriving as config is the same call with an extra step, and it ships "disabled by
    // default" — which is how it gets enabled during an incident.
    const offenders = readPath
      .filter((f) =>
        /process\.env\.[A-Z_]*(GR8|API_KEY|BASE_URL|ENDPOINT|WEBHOOK|TOKEN|S3_)/.test(codeOf(f)),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the read path holds no Redis client — the cache belongs to 5.4, not here', () => {
    // Worth separating from the outbound list: Redis is *internal*, so it would not look like reaching
    // outward. But a read that consults the GR8 cache is the 5.4 projection, and building half of it here
    // (with no stale flag and no 180-day boundary) is how the two distinct empty states get collapsed.
    const offenders = readPath.filter((f) => /\b(ioredis|createClient|RedisService)\b/.test(codeOf(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('the outbound predicate fires on a real call (so the emptiness means something)', () => {
    expect(/\bfetch\s*\(/.test('const r = await fetch(url);')).toBe(true);
    expect(/\bfetch\s*\(/.test('// we never fetch(') ).toBe(true); // raw text matches…
    expect(/\bfetch\s*\(/.test(codeOf(join(ROOT, ...'libs/common/src/paging/keyset.ts'.split('/'))))).toBe(
      false,
    ); // …but the stripped source does not.
  });
});

describe('*** FR-027: there is no write surface ***', () => {
  const WRITE_OPS = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw|queryRaw)\s*\(/;

  it('neither repository can write', () => {
    for (const repo of [
      'services/users/src/player/player.repository.ts',
      'services/users/src/operator/operator.repository.ts',
    ]) {
      const source = codeOf(join(ROOT, ...repo.split('/')));
      expect({ repo, writes: WRITE_OPS.test(source) }).toEqual({ repo, writes: false });
      // …and they do read, so the assertion above is not passing on an empty file.
      expect(source).toMatch(/\.(findUnique|findFirst|findMany)\s*\(/);
    }
  });

  it('the read controller performs no database write of its own', () => {
    const controller = codeOf(
      join(ROOT, ...'services/users/src/player/player.grpc.controller.ts'.split('/')),
    );
    expect(WRITE_OPS.test(controller)).toBe(false);
    // It has no Prisma client at all — the repositories own data access, which is what keeps this true
    // under later edits rather than only today.
    expect(controller).not.toMatch(/PrismaService|forAccount\s*\(/);
  });

  it('*** the ONE write it causes is the audit entry, and that is required not incidental ***', () => {
    const controller = codeOf(
      join(ROOT, ...'services/users/src/player/player.grpc.controller.ts'.split('/')),
    );
    // A reveal that is not recorded is the harvesting vector itself (SEC-AP3), so the read path writing an
    // audit row is the requirement, not an exception to it. Named here so "no writes" is not later
    // "simplified" into removing this one.
    expect(controller).toMatch(/this\.access\.record(View|BulkRead)\s*\(/);
    const audit = codeOf(join(ROOT, ...'services/users/src/audit/audit.repository.ts'.split('/')));
    expect(audit).toMatch(/\.create\s*\(/); // the append lives THERE, behind the append-only repository
  });

  it('every gateway route is a GET', () => {
    const source = readFileSync(
      join(ROOT, ...'services/gateway/src/players/players.controller.ts'.split('/')),
      'utf8',
    );
    const verbs = [...source.matchAll(/@(Get|Post|Put|Patch|Delete)\s*\(/g)].map((m) => m[1]);
    /**
     * ⚠️ **The load-bearing half is the FIRST assertion — every verb is `Get`.** That is FR-027: this
     * edge has no write surface, and a `@Post` appearing here would be the defect.
     *
     * The count below is only anti-vacuous: it fails if the regex stops matching and the set above
     * silently becomes `[]`-shaped nonsense. So a new READ route is expected to bump it, and that is
     * not a weakening — the verb assertion still covers the guarantee.
     * ⓘ 3 → 4 on 2026-08-10: `GET /operators?authUserIds=…` (the ticket window's Assignee chooser).
     */
    expect([...new Set(verbs)]).toEqual(['Get']);
    expect(verbs.length).toBe(4);
  });

  it('the contract declares no write RPC for a player or an operator', () => {
    const proto = readFileSync(join(ROOT, ...'libs/proto/crm/users/v1/users.proto'.split('/')), 'utf8');
    const service = /service\s+UsersReadService\s*\{([\s\S]*?)\n\}/.exec(proto);
    expect(service).not.toBeNull();
    const rpcs = [...service![1]!.matchAll(/rpc\s+(\w+)\s*\(/g)].map((m) => m[1]!);

    // ⚠️ The exact-membership list that used to stand here was REMOVED by feature 020, because this
    // test's own next comment says a fifth READ rpc should not have to touch it — and the list made
    // that false. Two tests asserting the same membership also means a contract change has to be
    // remembered in two places; the completeness check belongs in ONE, and it lives in
    // `services/users/src/maintenance/hosting.spec.ts`. What belongs HERE is the property.
    expect(rpcs.length).toBeGreaterThan(0); // the scan really read the contract

    // Stated as a property rather than as a list, so a fifth read RPC does not have to touch this
    // test while a mutation does.
    //
    // ⭐ W9 (spec 035) named one read the prefix rule cannot see: `LookupPlayerByContact` poses a
    // QUESTION — it mutates nothing in users_db except its own audit trail, which is the
    // accountability the capability requires (every attempt recorded, ADR 0044 §4). A NAMED
    // exemption rather than a widened prefix, so the next `Lookup*` rpc still has to argue its case
    // here. ⚠️ Found red on 2026-08-06 by running the ROOT suite for W15 — the W9 gate ran the
    // workspace suites and never this file, which is its own lesson about what "the gate" covers.
    const namedReads = new Set(['LookupPlayerByContact']);
    for (const name of rpcs) {
      expect({ name, isRead: /^(Get|List)/.test(name) || namedReads.has(name) }).toEqual({
        name,
        isRead: true,
      });
    }
  });

  it('the write-op predicate fires on a real write (so the emptiness means something)', () => {
    expect(WRITE_OPS.test('await db.player.update({ where: { id } });')).toBe(true);
    expect(WRITE_OPS.test('await db.player.deleteMany({});')).toBe(true);
    // …and does not fire on the column named `updated_at`, which is what a naive scan would trip on.
    expect(WRITE_OPS.test('orderBy: { updated_at: "desc" }')).toBe(false);
  });
});
