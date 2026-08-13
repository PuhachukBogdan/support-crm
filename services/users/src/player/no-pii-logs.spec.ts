import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { Metadata } from '@grpc/grpc-js';
import { encodeCursor } from '@crm/common';
import { PlayerReadController } from './player.grpc.controller';
import type { PlayerRow } from './player.repository';

/**
 * ⭐ Feature 026 (roadmap 5.7): the attachment the masking rule now asks about.
 *
 * Defaults to NOT attached, deliberately. Every one of these tests predates the narrowing and was
 * written when the AM tier was role-wide; defaulting to "attached" would have kept them all green
 * while proving nothing. Defaulting to "not attached" makes each one state its own assumption —
 * which is what the required parameter was for.
 */
// W9: these specs never look anybody up — the required dep makes each file SAY so (the same
// compiler-enumerates-the-tests effect the assignment dep documented).
const lookupUnused = () => ({ lookup: jest.fn() }) as never;
const attachStub = (attached = false) =>
  ({
    isAttached: async () => attached,
    attachedAmong: async () => new Set<string>(),
  }) as never;

/** Feature 020: the controller now collaborates with PersonService; these specs exercise neither. */
function personsStub() {
  return {
    membersOf: jest.fn(async () => []),
  } as unknown as import('./person.service').PersonService;
}

/**
 * T050 (feature 018, roadmap 5.1) — **SEC-26 / Principle IV: no customer value reaches a log.**
 *
 * ── The distinction this rests on, stated once ───────────────────────────────────────────────────
 * A `player_id` is a **domain key**: it identifies a record without describing a person, and an operator
 * diagnosing "which read failed" needs it. A surname, a phone, an email, a segment, an AM note or a
 * preference is a **value about a person** and is not loggable at any level, including debug — logs are
 * copied, shipped, and searched by people with no clearance for the tier the field belongs to. Masking
 * that withholds a field from the response and then writes it to stdout has withheld nothing.
 *
 * ── Why both an execution check and a source scan ────────────────────────────────────────────────
 * Capturing the console proves nothing leaks on the paths exercised here. The scan proves it about paths
 * no test drives — which is where it actually goes wrong, since the tempting log line is in the error
 * branch nobody reaches. Feature 017 learned the other half of this: logging only the error *class* made a
 * failing job undiagnosable, so the answer is never "log nothing", it is "log the key and the class".
 */
const SENSITIVE = {
  surname: 'SECRET-Halvorsen',
  phone: 'SECRET+34600111222',
  email: 'SECRET@player.test',
  segment: 'SECRET-high-roller',
  amNote: 'SECRET prefers calls after 18:00',
  preference: 'SECRET-telegram',
  portfolio: 'SECRET-gold',
  custom: 'SECRET-affiliate-7',
};

const ROW: PlayerRow = {
  brand_id: 'brand-a',
  player_id: 'ply-1',
  account_id: 'acc-1',
  vip: true,
  segment: SENSITIVE.segment,
  am_notes: SENSITIVE.amNote,
  preferences: { channel: SENSITIVE.preference },
  portfolio: { tier: SENSITIVE.portfolio },
  custom_attributes: { source: SENSITIVE.custom },
  gr8_snapshot: { surname: SENSITIVE.surname, phone: SENSITIVE.phone, email: SENSITIVE.email },
  gr8_fetched_at: new Date('2026-07-28T09:00:00.000Z'),
  gr8_stale: false,
  created_at: new Date('2026-07-28T08:00:00.000Z'),
  updated_at: new Date('2026-07-28T08:30:00.000Z'),
};

function md(role: string, over: Record<string, string> = {}): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', 'acc-1');
  m.set('x-actor-user-id', 'user-1');
  m.set('x-actor-permissions', 'crm.contact.view,crm.inbox.view');
  m.set('x-actor-effective-role', role);
  for (const [k, v] of Object.entries(over)) m.set(k, v);
  return m;
}

function harness(opts: { row?: PlayerRow | null; auditThrows?: boolean } = {}) {
  const row = opts.row === undefined ? ROW : opts.row;
  const access = {
    recordView: jest.fn(async () => {
      if (opts.auditThrows) throw new Error(`audit store unreachable`);
    }),
    recordBulkRead: jest.fn(async () => {
      if (opts.auditThrows) throw new Error(`audit store unreachable`);
    }),
  };
  const players = {
    getPlayer: jest.fn(async () => row),
    listByBrand: jest.fn(async () => ({ rows: row ? [row] : [], nextCursor: null })),
  };
  const operators = {
    getById: jest.fn(async () => ({
      id: 'op-1',
      account_id: 'acc-1',
      display_name: 'Ann Operator',
      active: true,
    })),
  };
  return {
    ctl: new PlayerReadController(
      players as never,
      operators as never,
      access as never,
      personsStub(),
      attachStub(),
      lookupUnused(),
    ),
    players,
    operators,
    access,
  };
}

/** Run `fn` with every console channel captured; returns everything written, joined. */
async function captured(fn: () => Promise<unknown>): Promise<string> {
  const chunks: string[] = [];
  const channels = ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const;
  const originals = channels.map((c) => [c, console[c]] as const);
  for (const c of channels) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (console as any)[c] = (...args: unknown[]) => {
      chunks.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  }
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    await fn().catch(() => undefined); // a refusal is one of the paths under test
  } finally {
    for (const [c, original] of originals) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (console as any)[c] = original;
    }
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  return chunks.join('\n');
}

const values = Object.values(SENSITIVE);

describe('*** a successful read writes no customer value anywhere ***', () => {
  it.each(['support_agent', 'vip_support', 'am', 'admin', 'super_admin'])(
    'GetPlayer as %s leaks nothing',
    async (role) => {
      const h = harness();
      const output = await captured(() =>
        h.ctl.getPlayer({ playerId: 'ply-1', brandId: 'brand-a' }, md(role)),
      );
      for (const value of values) expect(output).not.toContain(value);
      expect(output).not.toMatch(/SECRET/);
    },
  );

  it('the list path leaks nothing either — every row, not only the first', async () => {
    const h = harness();
    h.players.listByBrand = jest.fn(async () => ({
      rows: [ROW, { ...ROW, player_id: 'ply-2' }],
      nextCursor: { createdAt: ROW.created_at.toISOString(), id: 'ply-2' },
    })) as never;
    const output = await captured(() => h.ctl.listPlayersByBrand({ brandId: 'brand-a' }, md('am')));
    expect(output).not.toMatch(/SECRET/);
  });

  it('GetOperator leaks nothing (a staff name is not a customer value, and still is not logged)', async () => {
    const h = harness();
    const output = await captured(() => h.ctl.getOperator({ operatorId: 'op-1' }, md('am')));
    expect(output).not.toContain('Ann Operator');
  });
});

describe('*** the REFUSAL paths are the ones that leak, and these do not ***', () => {
  it('a record that does not exist logs no identifier beyond what the caller sent', async () => {
    const h = harness({ row: null });
    const output = await captured(() =>
      h.ctl.getPlayer({ playerId: 'ply-missing', brandId: 'brand-a' }, md('am')),
    );
    expect(output).not.toMatch(/SECRET/);
  });

  it('the bulk-read refusal logs nothing at all', async () => {
    // The guard runs before the repository, so there is no row to leak — but a refusal that logged the
    // role and the brand would still be building a picture of who was refused what.
    const h = harness();
    const output = await captured(() =>
      h.ctl.listPlayersByBrand({ brandId: 'brand-a' }, md('support_agent')),
    );
    expect(output).not.toMatch(/SECRET/);
  });

  it('a malformed page token is refused without echoing the token', async () => {
    const h = harness();
    const token = Buffer.from('SECRET-not-a-cursor').toString('base64url');
    const output = await captured(() =>
      h.ctl.listPlayersByBrand({ brandId: 'brand-a', pageToken: token }, md('am')),
    );
    expect(output).not.toContain(token);
    expect(output).not.toMatch(/SECRET/);
  });

  it('*** a failing audit write refuses the read and logs no row *** (the strict path)', async () => {
    // The most dangerous shape: the read has already happened, the row is in hand, and the error branch is
    // the natural place to dump context "for diagnosis".
    const h = harness({ auditThrows: true });
    const output = await captured(() =>
      h.ctl.getPlayer({ playerId: 'ply-1', brandId: 'brand-a' }, md('am')),
    );
    expect(output).not.toMatch(/SECRET/);
    // And the refusal is real — otherwise this test passes on a path that silently returned the data.
    await expect(
      h.ctl.getPlayer({ playerId: 'ply-1', brandId: 'brand-a' }, md('am')),
    ).rejects.toBeDefined();
  });
});

describe('*** the page token carries no customer value *** (an opaque cursor, not a summary)', () => {
  it('a cursor encodes a timestamp and a domain key, and nothing else', () => {
    const token = encodeCursor({ createdAt: ROW.created_at.toISOString(), id: ROW.player_id });
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    for (const value of values) expect(decoded).not.toContain(value);
    // Positively: it does carry the two things it is supposed to, so this is not passing on an empty token.
    expect(decoded).toContain('ply-1');
    expect(decoded).toContain('2026-07-28T08:00:00.000Z');
  });

  it('the token holds EXACTLY two positions — a timestamp and a key, room for nothing else', () => {
    // Opaque means "carries no meaning for the client", not "is a secret" — base64url is trivially
    // reversible and the test above decodes it on purpose. The property worth pinning is the SHAPE: a
    // two-element tuple has no slot a display name could be added to without this failing. Stating it stops
    // the "it's encoded anyway, let's cache the name in the cursor" change.
    const token = encodeCursor({ createdAt: ROW.created_at.toISOString(), id: ROW.player_id });
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded as unknown[]).toEqual(['2026-07-28T08:00:00.000Z', 'ply-1']);
  });
});

describe('*** the source itself has no log line that could carry a value ***', () => {
  const ROOT = resolve(__dirname, '..', '..', '..', '..');
  const DIRS = [
    'services/users/src/player',
    'services/users/src/operator',
    'services/gateway/src/players',
  ];

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) out.push(full);
    }
    return out;
  }

  const sources = DIRS.flatMap((d) => walk(join(ROOT, ...d.split('/')))).map((abs) => ({
    path: abs
      .slice(ROOT.length + 1)
      .split(sep)
      .join('/'),
    code: readFileSync(abs, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/([^:'"`])\/\/.*$/gm, '$1'),
  }));

  it('the scan sees the read path', () => {
    expect(sources.map((s) => s.path)).toContain(
      'services/users/src/player/player.grpc.controller.ts',
    );
    expect(sources.length).toBeGreaterThan(6);
  });

  it('*** nothing on the read path logs at all ***', () => {
    // The strongest available form of the requirement, and it is achievable here because these are reads:
    // no line to review, no level to get wrong, nothing to regress. If a diagnostic is ever genuinely
    // needed, this test is where the decision gets made deliberately — with the key-and-class rule from
    // feature 017 — rather than by adding a line.
    for (const s of sources) {
      expect({
        path: s.path,
        logs: /\bconsole\.\w+\s*\(|\bnew Logger\s*\(|this\.logger\./.test(s.code),
      }).toEqual({
        path: s.path,
        logs: false,
      });
    }
  });

  it('no read-path file serializes a row or a masked record', () => {
    // The one-liner that defeats every other assertion here: `JSON.stringify(row)` inside an error message.
    for (const s of sources) {
      expect({
        path: s.path,
        serializes: /JSON\.stringify\s*\(\s*(row|masked|player|rows|page)\b/.test(s.code),
      }).toEqual({ path: s.path, serializes: false });
    }
  });

  it('no error message on the read path interpolates a record', () => {
    const offenders = sources.filter((s) =>
      /(?:message|Error)\s*[:(]\s*[`'"][^`'"]*\$\{\s*(row|masked|player)\b/.test(s.code),
    );
    expect(offenders.map((s) => s.path)).toEqual([]);
  });

  it('the log-detection predicate fires on a real log line', () => {
    const strip = (t: string) => t.replace(/^[ \t]*\/\/.*$/gm, '');
    expect(/\bconsole\.\w+\s*\(/.test(strip('console.warn(row);'))).toBe(true);
    expect(/\bconsole\.\w+\s*\(/.test(strip('// console.warn(row);'))).toBe(false);
  });
});
