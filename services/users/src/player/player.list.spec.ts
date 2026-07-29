import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { decodeCursor, encodeCursor } from '@crm/common';
import { PlayerRepository } from './player.repository';
import { PlayerReadController } from './player.grpc.controller';
import type { PrismaService } from '../prisma.service';

/**
 * T033–T038 (feature 018, US2) — the brand page, and the guard in front of it.
 *
 * Two of these assertions are the reason the phase exists at all:
 *
 * - **"Exactly once" over a full traversal.** Asserted against a fake that actually honours the keyset
 *   predicate, the ordering and `take` — a fake that returns slices regardless would make the test about
 *   itself. Records sharing a `created_at` are included deliberately: without the tie-break they sit on a
 *   page boundary in an order the database is free to change between queries, and one is silently skipped
 *   while the other repeats.
 * - **The guard's ORDER.** Refusing after the read would still refuse — and would already have pulled a
 *   page of customer records into memory and filed an access entry for a disclosure that did not happen.
 *   So the assertion is on the *absence of the calls*, not on the absence of a result.
 */

/** Rows: two share an instant on purpose, so the tie-break is exercised rather than assumed. */
const ROWS = [
  { id: 'p1', at: '2026-07-28T12:00:00.000Z' },
  { id: 'p2', at: '2026-07-28T11:00:00.000Z' },
  { id: 'p3', at: '2026-07-28T10:00:00.000Z' }, // ties with p4
  { id: 'p4', at: '2026-07-28T10:00:00.000Z' }, // ties with p3
  { id: 'p5', at: '2026-07-28T09:00:00.000Z' },
  { id: 'p6', at: '2026-07-28T08:00:00.000Z' },
  { id: 'p7', at: '2026-07-28T07:00:00.000Z' },
].map((r) => ({
  player_id: r.id,
  account_id: 'acc-1',
  vip: false,
  segment: 'seg',
  am_notes: 'note',
  preferences: { a: 1 },
  portfolio: { b: 2 },
  custom_attributes: { c: 3 },
  gr8_snapshot: { surname: 'Smith' },
  gr8_fetched_at: null,
  gr8_stale: true,
  created_at: new Date(r.at),
  updated_at: new Date(r.at),
  brand_id: 'brand-a',
}));

/**
 * A Prisma fake that really pages: it applies the cursor's OR predicate, the `(created_at desc,
 * player_id desc)` ordering and `take`. Anything less and "exactly once" would be a property of the fake.
 */
function pagingPrisma(rows = ROWS) {
  const calls: Array<Record<string, unknown>> = [];
  const findMany = jest.fn(async (args: Record<string, unknown>) => {
    calls.push(args);
    const where = args.where as {
      brand_id?: string;
      OR?: Array<Record<string, unknown>>;
    };
    // Feature 020: the brand is a plain column predicate now. The fake follows the real query — it
    // used to reach through the `PlayerBrand` edge, which no longer exists.
    let out = rows.filter((r) => (where.brand_id ? r.brand_id === where.brand_id : true));

    if (where.OR) {
      const lt = (where.OR[0] as { created_at: { lt: Date } }).created_at.lt;
      const tie = (where.OR[1] as { AND: [{ created_at: Date }, { player_id: { lt: string } }] }).AND;
      const at = tie[0].created_at;
      const idLt = tie[1].player_id.lt;
      out = out.filter(
        (r) =>
          r.created_at.getTime() < lt.getTime() ||
          (r.created_at.getTime() === at.getTime() && r.player_id < idLt),
      );
    }

    out = [...out].sort((a, b) => {
      const d = b.created_at.getTime() - a.created_at.getTime();
      return d !== 0 ? d : b.player_id.localeCompare(a.player_id);
    });
    return out.slice(0, args.take as number);
  });
  const prisma = { forAccount: jest.fn(() => ({ player: { findMany } })) } as unknown as PrismaService;
  return { prisma, findMany, calls };
}

function md(role = 'am', over: Record<string, string> = {}): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', 'acc-1');
  m.set('x-actor-user-id', 'user-1');
  m.set('x-actor-permissions', 'crm.contact.view');
  m.set('x-actor-effective-role', role);
  for (const [k, v] of Object.entries(over)) m.set(k, v);
  return m;
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
    return {};
  } catch (err) {
    return (err as RpcException).getError() as { code?: number; message?: string };
  }
};

describe('*** T033: a full traversal covers every record EXACTLY ONCE ***', () => {
  it('no gap and no duplicate, at a page size that forces four pages', async () => {
    const { prisma } = pagingPrisma();
    const repo = new PlayerRepository(prisma);

    const seen: string[] = [];
    let cursor = null as ReturnType<typeof decodeCursor>;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await repo.listByBrand('acc-1', 'brand-a', 2, cursor);
      seen.push(...page.rows.map((r) => r.player_id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    expect(seen).toHaveLength(ROWS.length);
    expect(new Set(seen).size).toBe(ROWS.length); // no duplicate
    // …and in the declared order, newest first, ties broken by id descending.
    expect(seen).toEqual(['p1', 'p2', 'p4', 'p3', 'p5', 'p6', 'p7']);
  });

  it('*** the tie-break holds across a page boundary that splits an instant ***', async () => {
    // p3 and p4 share a `created_at`. With a page size of 3 the boundary falls between them, which is
    // exactly where a cursor without a tie-breaker loses one and repeats the other.
    const { prisma } = pagingPrisma();
    const repo = new PlayerRepository(prisma);

    const first = await repo.listByBrand('acc-1', 'brand-a', 3, null);
    expect(first.rows.map((r) => r.player_id)).toEqual(['p1', 'p2', 'p4']);
    const second = await repo.listByBrand('acc-1', 'brand-a', 3, first.nextCursor);
    expect(second.rows.map((r) => r.player_id)).toEqual(['p3', 'p5', 'p6']);
    // p3 appears once, in the second page, and p4 is not repeated.
    expect(second.rows.map((r) => r.player_id)).not.toContain('p4');
  });

  it('nextCursor is empty EXACTLY when the traversal is exhausted', async () => {
    const { prisma } = pagingPrisma();
    const repo = new PlayerRepository(prisma);
    const all = await repo.listByBrand('acc-1', 'brand-a', ROWS.length, null);
    expect(all.rows).toHaveLength(ROWS.length);
    expect(all.nextCursor).toBeNull();

    const short = await repo.listByBrand('acc-1', 'brand-a', ROWS.length - 1, null);
    expect(short.nextCursor).not.toBeNull();
  });

  it('the query takes limit + 1 — no COUNT and no offset (Principle VII)', async () => {
    const { prisma, calls } = pagingPrisma();
    await new PlayerRepository(prisma).listByBrand('acc-1', 'brand-a', 2, null);
    expect(calls[0]!.take).toBe(3);
    expect(JSON.stringify(calls[0])).not.toContain('skip');
    expect(calls[0]!.orderBy).toEqual([{ created_at: 'desc' }, { player_id: 'desc' }]);
  });

  it('an empty brand is an empty page, and a SUCCESS (FR-005)', async () => {
    const { prisma } = pagingPrisma();
    const page = await new PlayerRepository(prisma).listByBrand('acc-1', 'brand-nobody', 10, null);
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('*** page tokens: malformed is refused, FOREIGN is accepted and still filtered ***', () => {
  it('a malformed token is INVALID_ARGUMENT, never a silent first page', async () => {
    const { prisma } = pagingPrisma();
    const ctl = new PlayerReadController(
      new PlayerRepository(prisma) as never,
      { getById: jest.fn() } as never,
      { recordView: jest.fn(), recordBulkRead: jest.fn(async () => undefined) } as never,
    );
    const res = await failure(
      ctl.listPlayersByBrand({ brandId: 'brand-a', pageToken: 'not-a-token!!' }, md()),
    );
    expect(res.code).toBe(GrpcStatus.INVALID_ARGUMENT);
  });

  it('a WELL-FORMED token from another query resumes there and is still brand-filtered', async () => {
    /**
     * The property corrected during analysis. An opaque position cursor carries no query identity, so it
     * cannot be refused for coming from elsewhere — and it does not need to be: the brand and account
     * predicates are re-applied on EVERY page and never travel inside the token. A foreign cursor can shift
     * where a page begins; it can never widen what the page may contain.
     */
    const { prisma } = pagingPrisma();
    const repo = new PlayerRepository(prisma);
    const foreign = encodeCursor({ createdAt: '2026-07-28T11:00:00.000Z', id: 'p2' });

    const page = await repo.listByBrand('acc-1', 'brand-a', 10, decodeCursor(foreign));
    // Resumed mid-list rather than refused…
    expect(page.rows.map((r) => r.player_id)).toEqual(['p4', 'p3', 'p5', 'p6', 'p7']);
    // …and every record still belongs to the requested brand. Feature 020: the brand is a COLUMN on
    // the row now, not an edge to search — the filter, the sort and this assertion all read one table.
    for (const row of page.rows) {
      expect(row.brand_id).toBe('brand-a');
    }
  });
});

describe('*** T034: the bulk guard refuses BEFORE the repository and BEFORE any entry ***', () => {
  function guardHarness(role: string) {
    const players = { getPlayer: jest.fn(), listByBrand: jest.fn(async () => ({ rows: [], nextCursor: null })) };
    const access = { recordView: jest.fn(), recordBulkRead: jest.fn(async () => undefined) };
    return {
      ctl: new PlayerReadController(players as never, { getById: jest.fn() } as never, access as never),
      players,
      access,
      role,
    };
  }

  it('a linear role is refused, and NOTHING was read or written', async () => {
    const h = guardHarness('support_agent');
    const res = await failure(h.ctl.listPlayersByBrand({ brandId: 'brand-a' }, md('support_agent')));

    expect(res.code).toBe(GrpcStatus.PERMISSION_DENIED);
    // The load-bearing pair. Asserted as the ABSENCE of the calls: a guard that refuses after reading has
    // already loaded a page of customer records into memory, and has already filed an access entry for a
    // disclosure that did not happen.
    expect(h.players.listByBrand).not.toHaveBeenCalled();
    expect(h.access.recordBulkRead).not.toHaveBeenCalled();
  });

  it('an ABSENT role is refused too — fail-closed, never treated as cleared', async () => {
    const h = guardHarness('');
    const bare = new Metadata();
    bare.set('x-actor-account-id', 'acc-1');
    bare.set('x-actor-permissions', 'crm.contact.view');
    expect((await failure(h.ctl.listPlayersByBrand({ brandId: 'brand-a' }, bare))).code).toBe(
      GrpcStatus.PERMISSION_DENIED,
    );
    expect(h.players.listByBrand).not.toHaveBeenCalled();
  });

  it.each(['am', 'shift_am', 'admin', 'super_admin'])('%s is allowed through', async (role) => {
    const h = guardHarness(role);
    await h.ctl.listPlayersByBrand({ brandId: 'brand-a' }, md(role));
    expect(h.players.listByBrand).toHaveBeenCalled();
  });

  it('*** T035: breadth of permissions does NOT relax it — the ROLE decides ***', async () => {
    // SEC-AP2's actual content. A linear role holding every permission key in the catalogue is still
    // refused, because the decision comes from field-tier clearance rather than from how many keys a role
    // holds. Asserted by handing the request a maximal permission set.
    const h = guardHarness('support_agent');
    const loaded = new Metadata();
    loaded.set('x-actor-account-id', 'acc-1');
    loaded.set('x-actor-user-id', 'user-1');
    loaded.set(
      'x-actor-permissions',
      'crm.contact.view,crm.contact.read_pii,platform.role.manage,platform.settings.manage',
    );
    loaded.set('x-actor-effective-role', 'support_agent');

    expect((await failure(h.ctl.listPlayersByBrand({ brandId: 'brand-a' }, loaded))).code).toBe(
      GrpcStatus.PERMISSION_DENIED,
    );
    expect(h.players.listByBrand).not.toHaveBeenCalled();
  });
});

describe('*** T036: the brand is intersected with the caller PERMITTED set ***', () => {
  function brandHarness() {
    const players = {
      getPlayer: jest.fn(),
      listByBrand: jest.fn(async () => ({ rows: [], nextCursor: null })),
    };
    const access = { recordView: jest.fn(), recordBulkRead: jest.fn(async () => undefined) };
    return {
      ctl: new PlayerReadController(players as never, { getById: jest.fn() } as never, access as never),
      players,
      access,
    };
  }

  it('a brand the caller may NOT serve yields an empty page — never a wider result', async () => {
    const h = brandHarness();
    const scoped = md('am', { 'x-actor-brands': 'brand-a,brand-b' });
    const page = await h.ctl.listPlayersByBrand({ brandId: 'brand-z' }, scoped);

    expect(page).toEqual({ players: [], nextPageToken: '' });
    // The dangerous direction is widening: the query must not run unfiltered.
    expect(h.players.listByBrand).not.toHaveBeenCalled();
    // …and nothing is recorded, because nothing was disclosed.
    expect(h.access.recordBulkRead).not.toHaveBeenCalled();
  });

  it('a permitted brand is passed through', async () => {
    const h = brandHarness();
    await h.ctl.listPlayersByBrand({ brandId: 'brand-a' }, md('am', { 'x-actor-brands': 'brand-a,brand-b' }));
    expect(h.players.listByBrand).toHaveBeenCalledWith('acc-1', 'brand-a', 50, null);
  });

  it('an absent brand scope defers exactly as the conversation reads do', async () => {
    // Brands is roadmap 5.2. Until it populates the caller's set, the requested brand is used as-is —
    // mirroring the existing deferral rather than inventing a stricter or looser third behaviour.
    const h = brandHarness();
    await h.ctl.listPlayersByBrand({ brandId: 'brand-a' }, md('am'));
    expect(h.players.listByBrand).toHaveBeenCalledWith('acc-1', 'brand-a', 50, null);
  });

  it('a missing brand yields an empty page rather than every customer', async () => {
    const h = brandHarness();
    expect(await h.ctl.listPlayersByBrand({}, md('am'))).toEqual({ players: [], nextPageToken: '' });
    expect(h.players.listByBrand).not.toHaveBeenCalled();
  });
});

describe('*** T037/T038: ONE entry per request, and every row masked ***', () => {
  function listHarness(role: string) {
    const bulk: Array<{ target: string; roleKey: string; filters: string[] }> = [];
    const access = {
      recordView: jest.fn(),
      recordBulkRead: jest.fn(
        async (_a: string, _u: string, target: string, roleKey: string, filters: string[]) => {
          bulk.push({ target, roleKey, filters });
        },
      ),
    };
    const players = {
      getPlayer: jest.fn(),
      listByBrand: jest.fn(async () => ({ rows: ROWS, nextCursor: null })),
    };
    return {
      ctl: new PlayerReadController(players as never, { getById: jest.fn() } as never, access as never),
      access,
      bulk,
      role,
    };
  }

  it('a page of seven records writes ONE entry, targeting the BRAND', async () => {
    const h = listHarness('am');
    await h.ctl.listPlayersByBrand({ brandId: 'brand-a' }, md('am'));

    expect(h.access.recordBulkRead).toHaveBeenCalledTimes(1);
    expect(h.bulk[0]!.target).toBe('brand-a');
    // Filter NAMES, never values. Same call feature 017 made for exports, for the same reason: a per-row
    // trail over a paged list is useless to read and is the largest surface for leaking a value.
    expect(h.bulk[0]!.filters).toEqual(['brandId']);
  });

  it('every row in the page is masked to the caller tier, identically to a single read', async () => {
    const h = listHarness('teamlead');
    const page = (await h.ctl.listPlayersByBrand({ brandId: 'brand-a' }, md('teamlead'))) as {
      players: Record<string, unknown>[];
    };

    expect(page.players).toHaveLength(ROWS.length);
    for (const p of page.players) {
      // Operational is visible for a teamlead…
      expect(p.segment).toBe('seg');
      // …and the portfolio side is not. The list must not have its own projection.
      // Absent, not blank (011's FR-014) — see the note on `toPlayerWire` rule 4. Checked with
      // `hasOwnProperty` because an emptiness test would pass for either, and telling those two apart
      // is the entire point of the requirement.
      for (const k of ['amNotes', 'preferencesJson', 'portfolioJson']) {
        expect(Object.prototype.hasOwnProperty.call(p, k)).toBe(false);
      }
    }
    // The top-tier payload is absent from every row, at the wire layer.
    expect(JSON.stringify(page.players)).not.toContain('Smith');
  });

  it('the page token round-trips through the edge shape', async () => {
    const players = {
      getPlayer: jest.fn(),
      listByBrand: jest.fn(async () => ({
        rows: ROWS.slice(0, 2),
        nextCursor: { createdAt: '2026-07-28T11:00:00.000Z', id: 'p2' },
      })),
    };
    const ctl = new PlayerReadController(
      players as never,
      { getById: jest.fn() } as never,
      { recordView: jest.fn(), recordBulkRead: jest.fn(async () => undefined) } as never,
    );
    const page = (await ctl.listPlayersByBrand({ brandId: 'brand-a' }, md('am'))) as {
      nextPageToken: string;
    };
    expect(decodeCursor(page.nextPageToken)).toEqual({
      createdAt: '2026-07-28T11:00:00.000Z',
      id: 'p2',
    });
  });
});
