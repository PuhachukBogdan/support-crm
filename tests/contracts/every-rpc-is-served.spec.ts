import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');

/**
 * Feature 022 (roadmap 4.13), T033–T037 — **every rpc a contract declares has a handler, or says why not
 * at its declaration.**
 *
 * ── Why this exists, and why it is repo-wide ────────────────────────────────────────────────────
 * Feature 020 declared `ChatsReadService.GetPersonFeed` and implemented nothing: no handler, no route, no
 * test. The point closed, and the contract went on promising a call that answered UNIMPLEMENTED. Nothing
 * failed, because `chats` had no guard of this kind — `users` has had one since feature 017
 * (`services/users/src/maintenance/hosting.spec.ts`), which is precisely why `users` cannot repeat it.
 *
 * The spec asked for this guard on the chats read service. Running the check by hand across every service
 * FIRST — before writing it — found two more, so it is written repo-wide instead:
 *
 *   • `BrandsReadService.CheckBrandAccess` — deliberate. `option deprecated = true`, documented in the
 *     controller, asserted in `brand.spec.ts`. Removing an rpc trips `buf breaking`, so ADR 0038 chose
 *     deprecate-and-assert-unserved.
 *   • `AuthService.ResendLoginCode` — a NEW finding. Declared by feature 009 as "optional this feature",
 *     never implemented, and roadmap 3.11 (the login flow) closed `[x]` without it. So no open point owns
 *     it, and a deliberate absence was indistinguishable from an oversight.
 *
 * A chats-only guard would have left two of the three invisible. That is the third time in this project
 * that hunting one inert contract entry turned up more (ADR 0038's two dead brand controls; the 5.2
 * correction's third service; this).
 *
 * ── The exemption mechanism lives at the DECLARATION, not in this file ──────────────────────────
 * Two markers, both read from the proto:
 *   1. `option deprecated = true` on the rpc;
 *   2. an `UNSERVED:` note in the comment block immediately above it.
 *
 * A list inside this test would be read by whoever runs the test. A marker at the declaration is read by
 * whoever is about to depend on the rpc — which is the person who needs to know.
 *
 * ⚠️ A marked rpc that GAINS a handler fails this guard. An exemption that outlives its reason is the same
 * disease as a permanently-false authorization branch: it reads as a live decision while deciding nothing.
 */

/** Contract → the service directory whose sources must contain the handlers. */
const CONTRACTS: ReadonlyArray<{ proto: string; service: string }> = [
  { proto: 'libs/proto/crm/chats/v1/chats.proto', service: 'services/chats/src' },
  { proto: 'libs/proto/crm/users/v1/users.proto', service: 'services/users/src' },
  { proto: 'libs/proto/crm/auth/v1/auth.proto', service: 'services/auth/src' },
  { proto: 'libs/proto/crm/brands/v1/brands.proto', service: 'services/brands/src' },
];

const SKIP_DIRS = new Set(['generated', 'node_modules', 'dist']);

interface DeclaredRpc {
  contract: string;
  service: string;
  name: string;
  rpc: string;
  /** Deprecated in the contract, or carrying an `UNSERVED:` note above it. */
  marked: boolean;
  markerKind: 'deprecated' | 'unserved-note' | null;
}

/**
 * Parse every `service { rpc … }` block. The `marked` flag is computed from the rpc's own line plus the
 * comment block immediately above it — so the exemption is local to the declaration and cannot be
 * inherited from a neighbour.
 */
export function declaredRpcs(protoText: string): Omit<DeclaredRpc, 'contract' | 'service'>[] {
  const out: Omit<DeclaredRpc, 'contract' | 'service'>[] = [];
  for (const svc of protoText.matchAll(/service\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const name = svc[1]!;
    const body = svc[2]!;
    const lines = body.split('\n');
    lines.forEach((line, i) => {
      const m = /^\s*rpc\s+(\w+)\s*\(/.exec(line);
      if (!m) return;
      const deprecated = /option\s+deprecated\s*=\s*true/.test(line);
      // Walk back over the contiguous comment block directly above the rpc.
      let unserved = false;
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j]!.trim();
        if (prev === '') break;
        if (!prev.startsWith('//')) break;
        if (/UNSERVED:/.test(prev)) unserved = true;
      }
      out.push({
        name,
        rpc: m[1]!,
        marked: deprecated || unserved,
        markerKind: deprecated ? 'deprecated' : unserved ? 'unserved-note' : null,
      });
    });
  }
  return out;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) yield full;
  }
}

/** All handler declarations in a service, normalised so formatting cannot hide one. */
function handlersIn(serviceDir: string): string {
  const parts: string[] = [];
  for (const file of walk(join(ROOT, serviceDir))) parts.push(readFileSync(file, 'utf8'));
  return parts.join('\n').replace(/\s+/g, ' ');
}

export function hasHandler(handlers: string, service: string, rpc: string): boolean {
  // `String.raw` deliberately: inside an ordinary template literal `\s` collapses to `s`, which silently
  // makes the pattern match nothing and reports every rpc as unhandled. That exact bug hit
  // `hosting.spec.ts` on its first run — a test that fails for its own reasons is worse than no test.
  return new RegExp(String.raw`@GrpcMethod\(\s*'${service}'\s*,\s*'${rpc}'\s*\)`).test(handlers);
}

const ALL: DeclaredRpc[] = CONTRACTS.flatMap(({ proto, service }) =>
  declaredRpcs(readFileSync(join(ROOT, proto), 'utf8')).map((r) => ({
    ...r,
    contract: proto,
    service,
  })),
);

const HANDLERS = new Map(CONTRACTS.map(({ service }) => [service, handlersIn(service)]));

describe('T033 — every declared rpc is served', () => {
  it('the scan found every contract and a plausible number of rpcs', () => {
    // Reach assertion first: a parse that silently matched nothing would make everything below pass while
    // proving nothing. This is the failure mode that made a `git grep` guard permanently green on
    // 2026-07-29.
    expect(ALL.length).toBeGreaterThan(40);
    for (const { proto } of CONTRACTS) {
      expect(ALL.some((r) => r.contract === proto)).toBe(true);
    }
    for (const [, handlers] of HANDLERS) expect(handlers.length).toBeGreaterThan(1000);
  });

  it('no unmarked rpc is left without a handler', () => {
    const unserved = ALL.filter(
      (r) => !r.marked && !hasHandler(HANDLERS.get(r.service)!, r.name, r.rpc),
    ).map((r) => `${r.name}.${r.rpc}`);
    expect(unserved).toEqual([]);
  });

  it('every MARKED rpc is genuinely unserved (a stale marker fails here)', () => {
    // The other direction, and the one that keeps the escape hatch honest: an exempted rpc that has since
    // been implemented must lose its marker, or the marker would excuse a decision nobody is making.
    const staleMarkers = ALL.filter(
      (r) => r.marked && hasHandler(HANDLERS.get(r.service)!, r.name, r.rpc),
    ).map((r) => `${r.name}.${r.rpc} (${r.markerKind})`);
    expect(staleMarkers).toEqual([]);
  });

  it('the two known exemptions are exactly the ones expected, with the marker each carries', () => {
    // Pinned so a THIRD unserved rpc cannot be quietly waved through by adding a marker: growing this list
    // is a visible act, which is the whole point of the guard.
    const marked = ALL.filter((r) => r.marked).map((r) => `${r.name}.${r.rpc}:${r.markerKind}`);
    expect(marked.sort()).toEqual([
      'AuthService.ResendLoginCode:unserved-note',
      'BrandsReadService.CheckBrandAccess:deprecated',
    ]);
  });
});

describe('T037 — the controllers that carry chats read handlers are registered', () => {
  it('the contact-summary and feed controllers are in the chats module graph', async () => {
    // A handler in an unregistered module contributes nothing, and the service answers UNIMPLEMENTED while
    // looking perfectly healthy — feature 015's single live-only defect, one level up from an unserved rpc.
    // Read from Nest's own metadata rather than from source text.
    const { AppModule } = await import('../../services/chats/src/app.module');
    const controllers = (Reflect.getMetadata('controllers', AppModule) ?? []) as Array<{
      name?: string;
    }>;
    const names = controllers.map((c) => c?.name ?? '');
    expect(names).toContain('ContactSummaryController');
    expect(names).toContain('FeedReadController');
  });
});

describe('T036 — the detector can fail (proved on planted input)', () => {
  const planted = (body: string) => `service S {\n${body}\n}`;

  it('sees a plain rpc as unmarked', () => {
    const [rpc] = declaredRpcs(planted('  rpc DoThing(A) returns (B);'));
    expect(rpc).toMatchObject({ name: 'S', rpc: 'DoThing', marked: false, markerKind: null });
  });

  it('honours `option deprecated = true` on the rpc line', () => {
    const [rpc] = declaredRpcs(
      planted('  rpc Old(A) returns (B) { option deprecated = true; };'),
    );
    expect(rpc).toMatchObject({ rpc: 'Old', marked: true, markerKind: 'deprecated' });
  });

  it('honours an UNSERVED note in the comment block directly above', () => {
    const [rpc] = declaredRpcs(planted('  // UNSERVED: nobody owns this yet.\n  rpc Later(A) returns (B);'));
    expect(rpc).toMatchObject({ rpc: 'Later', marked: true, markerKind: 'unserved-note' });
  });

  it('does NOT let a marker leak onto the next rpc past a blank line', () => {
    // The subtle failure: one marker silently excusing a neighbour. A blank line ends the comment block.
    const rpcs = declaredRpcs(
      planted('  // UNSERVED: this one.\n  rpc Marked(A) returns (B);\n\n  rpc NotMarked(A) returns (B);'),
    );
    expect(rpcs.map((r) => [r.rpc, r.marked])).toEqual([
      ['Marked', true],
      ['NotMarked', false],
    ]);
  });

  it('does not treat a note further up, separated by code, as a marker', () => {
    const rpcs = declaredRpcs(
      planted('  // UNSERVED: about the one below.\n  rpc A1(A) returns (B);\n  rpc A2(A) returns (B);'),
    );
    expect(rpcs.map((r) => r.marked)).toEqual([true, false]);
  });

  it('matches a handler regardless of formatting, and only for the right service', () => {
    const handlers = "@GrpcMethod( 'ChatsReadService' , 'GetThread' ) async getThread() {}".replace(
      /\s+/g,
      ' ',
    );
    expect(hasHandler(handlers, 'ChatsReadService', 'GetThread')).toBe(true);
    expect(hasHandler(handlers, 'ChatsWriteService', 'GetThread')).toBe(false);
    expect(hasHandler(handlers, 'ChatsReadService', 'GetThreadX')).toBe(false);
  });

  it('finds every service block in a multi-service proto', () => {
    const rpcs = declaredRpcs(
      'service A {\n  rpc X(R) returns (S);\n}\n\nservice B {\n  rpc Y(R) returns (S);\n}',
    );
    expect(rpcs.map((r) => `${r.name}.${r.rpc}`)).toEqual(['A.X', 'B.Y']);
  });
});
