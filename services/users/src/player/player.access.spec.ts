import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { PlayerReadController } from './player.grpc.controller';

/**
 * ⭐ Feature 026 (roadmap 5.7): the attachment the masking rule now asks about.
 *
 * Defaults to NOT attached, deliberately. Every one of these tests predates the narrowing and was
 * written when the AM tier was role-wide; defaulting to "attached" would have kept them all green
 * while proving nothing. Defaulting to "not attached" makes each one state its own assumption —
 * which is what the required parameter was for.
 */
// W9: these specs never look anybody up — the required dep makes each file SAY so.
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
 * T022 (feature 018, US1) — **"not yours" and "does not exist" are the SAME answer** (FR-011 / SC-004).
 *
 * Any difference between them is an existence oracle: a distinct answer for a real record belonging to
 * another account tells the asker the identifier is real, and a few hundred guesses becomes a map of who
 * exists. So both the status **and** the message are compared.
 *
 * The last block is the one that keeps the property alive. Behaviour can be re-implemented; what cannot
 * quietly come back is a `row.account_id !== caller` comparison, because there is nowhere in the read path
 * that holds a foreign row to compare. That is asserted as a **scan**, not as taste.
 */
const ROOT = resolve(__dirname, '..', '..', '..', '..');

function md(account = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', account);
  m.set('x-actor-user-id', 'user-1');
  m.set('x-actor-permissions', 'crm.contact.view,crm.inbox.view');
  m.set('x-actor-effective-role', 'am');
  return m;
}

/** A repository fake that behaves like the scoped client: a row exists only for its own account. */
function harness() {
  const access = {
    recordView: jest.fn(async () => undefined),
    recordBulkRead: jest.fn(async () => undefined),
  };
  const players = {
    getPlayer: jest.fn(async (id: { accountId: string; brandId: string; playerId: string }) =>
      id.accountId === 'acc-1' && id.playerId === 'ply-1'
        ? {
            player_id: 'ply-1',
            account_id: 'acc-1',
            vip: false,
            segment: null,
            am_notes: null,
            preferences: null,
            portfolio: null,
            custom_attributes: null,
            gr8_snapshot: null,
            gr8_fetched_at: null,
            gr8_stale: true,
            created_at: new Date(),
            updated_at: new Date(),
            brands: [],
          }
        : null,
    ),
    listByBrand: jest.fn(async () => ({ rows: [], nextCursor: null })),
    // Feature 022: the person lookup. `null` — an unlinked record, which is the state that must leave the
    // byte-identical unknown/not-yours answers below completely unchanged.
    personIdOf: jest.fn(async () => null),
    personIdsFor: jest.fn(async () => new Map<string, string>()),
  };
  const operators = {
    getById: jest.fn(async (accountId: string, id: string) =>
      accountId === 'acc-1' && id === 'op-1'
        ? { id: 'op-1', account_id: 'acc-1', display_name: 'Ann', active: false }
        : null,
    ),
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

const failure = async (p: Promise<unknown>): Promise<{ code?: number; message?: string }> => {
  try {
    await p;
    return {};
  } catch (err) {
    return (err as RpcException).getError() as { code?: number; message?: string };
  }
};

describe('*** GetPlayer: unknown and not-yours are byte-identical ***', () => {
  it('the owner reads their own record', async () => {
    const wire = (await harness().ctl.getPlayer(
      { playerId: 'ply-1', brandId: 'brand-a' },
      md(),
    )) as Record<string, unknown>;
    expect(wire.playerId).toBe('ply-1');
  });

  it.each([
    ['an unknown id', 'ply-nope', 'acc-1'],
    ['a real id from ANOTHER account', 'ply-1', 'acc-2'],
  ])('%s → the same NOT_FOUND, status and message', async (_label, id, account) => {
    const res = await failure(
      harness().ctl.getPlayer({ playerId: id, brandId: 'brand-a' }, md(account)),
    );
    expect(res.code).toBe(GrpcStatus.NOT_FOUND);
    expect(res.message).toBe('not found');
  });

  /**
   * ⚠️ CHANGED DELIBERATELY BY FEATURE 020 — an empty identifier is now INVALID_ARGUMENT, not NOT_FOUND.
   *
   * It used to be grouped with the two cases above so that all three answered identically. That
   * grouping conflated two different properties. **The one that matters is preserved untouched**: an
   * unknown id and another account's id remain byte-identical, so nothing tells a caller which records
   * exist — that is the oracle, and it is still closed (the two cases above).
   *
   * An EMPTY id is not a record at all; it is a malformed request, judged on the request's SHAPE before
   * anything is read. It can reveal nothing about which ids exist, because no id was supplied. Reporting
   * it as "not found" was, if anything, the less honest answer.
   */
  it.each([
    ['an empty player id', { playerId: '', brandId: 'brand-a' }],
    ['a missing brand', { playerId: 'ply-1' } as { playerId: string; brandId?: string }],
    ['an empty brand', { playerId: 'ply-1', brandId: '' }],
  ])('%s → INVALID_ARGUMENT, evaluated before any read', async (_label, req) => {
    const h = harness();
    const res = await failure(h.ctl.getPlayer(req as { playerId: string }, md()));
    expect(res.code).toBe(GrpcStatus.INVALID_ARGUMENT);
    // Refused on shape alone — the repository was never asked, so the answer cannot depend on data.
    expect(h.players.getPlayer).not.toHaveBeenCalled();
  });

  it('the refusal names the parameters and never the id that was sent', async () => {
    const res = await failure(
      harness().ctl.getPlayer({ playerId: 'seed-player-001' } as { playerId: string }, md()),
    );
    expect(res.message).toContain('brandId');
    expect(res.message).not.toContain('seed-player-001');
  });

  it('the account always goes INTO the query — it is never compared afterwards', async () => {
    const h = harness();
    await h.ctl.getPlayer({ playerId: 'ply-1', brandId: 'brand-a' }, md());
    expect(h.players.getPlayer).toHaveBeenCalledWith({
      accountId: 'acc-1',
      brandId: 'brand-a',
      playerId: 'ply-1',
    });
  });

  it('a missing account context is refused before any read (Principle I)', async () => {
    const h = harness();
    const bare = new Metadata();
    bare.set('x-actor-user-id', 'user-1');
    expect(
      (await failure(h.ctl.getPlayer({ playerId: 'ply-1', brandId: 'brand-a' }, bare))).code,
    ).toBe(GrpcStatus.PERMISSION_DENIED);
    expect(h.players.getPlayer).not.toHaveBeenCalled();
  });

  it('*** a 404 writes NO audit entry — nothing was revealed ***', async () => {
    // The property feature 015's live run recorded for deletions, applied here: no entry filed for a reveal
    // that never happened. Auditing a miss would also make the trail an enumeration oracle of its own.
    const h = harness();
    await failure(h.ctl.getPlayer({ playerId: 'ply-nope', brandId: 'brand-a' }, md()));
    expect(h.access.recordView).not.toHaveBeenCalled();
  });
});

describe('GetOperator: the same treatment for staff', () => {
  it('an in-account operator returns, with its inactive state visible', async () => {
    // Returned rather than filtered on: a name still has to render on last year's conversations.
    const wire = (await harness().ctl.getOperator({ operatorId: 'op-1' }, md())) as Record<
      string,
      unknown
    >;
    expect(wire).toEqual({
      operatorId: 'op-1',
      accountId: 'acc-1',
      displayName: 'Ann',
      active: false,
    });
  });

  it.each([
    ['an unknown id', 'op-nope', 'acc-1'],
    ['another account’s id', 'op-1', 'acc-2'],
  ])('%s → the same NOT_FOUND', async (_label, id, account) => {
    const res = await failure(harness().ctl.getOperator({ operatorId: id }, md(account)));
    expect(res.code).toBe(GrpcStatus.NOT_FOUND);
    expect(res.message).toBe('not found');
  });

  it('*** a staff read writes NO access entry, and that is a decision *** (FR-024)', async () => {
    // FR-024 exists precisely so "obviously staff need no auditing" is recorded rather than assumed. The
    // policy classifies CUSTOMER fields, and an operator's name already renders on every message they sent —
    // so an entry here would record something the reader can see by scrolling. If an operator record ever
    // grows a personal field, this test is the one that has to change.
    const h = harness();
    await h.ctl.getOperator({ operatorId: 'op-1' }, md());
    expect(h.access.recordView).not.toHaveBeenCalled();
    expect(h.access.recordBulkRead).not.toHaveBeenCalled();
  });
});

describe('*** no account comparison exists in the read path *** (the property, not the behaviour)', () => {
  const files = readdirSync(join(ROOT, 'services', 'users', 'src', 'player'))
    .concat()
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
    .map((f) => ({
      name: `player/${f}`,
      src: readFileSync(join(ROOT, 'services', 'users', 'src', 'player', f), 'utf8'),
    }))
    .concat(
      readdirSync(join(ROOT, 'services', 'users', 'src', 'operator'))
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
        .map((f) => ({
          name: `operator/${f}`,
          src: readFileSync(join(ROOT, 'services', 'users', 'src', 'operator', f), 'utf8'),
        })),
    );

  it('the scan sees the read path (not silently empty)', () => {
    expect(files.map((f) => f.name)).toContain('player/player.grpc.controller.ts');
    expect(files.map((f) => f.name)).toContain('operator/operator.repository.ts');
  });

  it.each(files.map((f) => [f.name, f.src] as const))('%s compares no account id', (_name, src) => {
    // Comments legitimately discuss the property; a COMPARISON is the defect. So the scan reads code only.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
      .replace(/([^:'"`])\/\/.*$/gm, '$1');

    // The shape that would split one answer into two: holding a row and COMPARING whose it is.
    //
    // Comparison only — READING the field for a response is legitimate and was the first draft's mistake:
    // the scan flagged `accountId: row.account_id` in the operator mapping, which discloses nothing. (It
    // has since been unified to take the value from the caller's context on both paths, so the pattern is
    // one rule rather than two, but the scan is now correct either way.)
    expect(code).not.toMatch(/account_id\s*(!==|===|!=|==)/);
    expect(code).not.toMatch(/(!==|===|!=|==)\s*\w*\.account_id/);
    expect(code).not.toMatch(/if\s*\([^)]*\.account_id/);
  });
});

describe('*** T024: an unwritable REVEAL entry refuses the read *** (FR-016)', () => {
  it('the caller gets no data when the entry cannot be written', async () => {
    /**
     * The direction that matters. An unaudited reveal is the harvesting vector SEC-AP3 exists to detect,
     * not a lost statistic — feature 011 chose this, and feature 015 reconsidered relaxing it and kept it
     * after reading the code. So the write is awaited un-caught and a failure propagates.
     *
     * The opposite direction — best-effort for a read that discloses nothing sensitive — is exactly what
     * `record.open` would have been, and it is not implemented here: feature 015 attached a retention
     * precondition to that action which is still unmet. So there is only one direction to assert today, and
     * that asymmetry is the honest state of the feature rather than half a test.
     */
    const players = {
      getPlayer: jest.fn(async () => ({
        player_id: 'ply-1',
        account_id: 'acc-1',
        vip: true,
        segment: 'x',
        am_notes: null,
        preferences: null,
        portfolio: null,
        custom_attributes: null,
        gr8_snapshot: null,
        gr8_fetched_at: null,
        gr8_stale: true,
        created_at: new Date(),
        updated_at: new Date(),
        brands: [],
      })),
      listByBrand: jest.fn(),
      personIdOf: jest.fn(async () => null),
      personIdsFor: jest.fn(async () => new Map<string, string>()),
    };
    const access = {
      recordView: jest.fn(async () => {
        throw new Error('audit table unavailable');
      }),
      recordBulkRead: jest.fn(),
    };
    const ctl = new PlayerReadController(
      players as never,
      { getById: jest.fn() } as never,
      access as never,
      personsStub(),
      attachStub(),
      lookupUnused(),
    );

    await expect(ctl.getPlayer({ playerId: 'ply-1', brandId: 'brand-a' }, md())).rejects.toThrow(
      'audit table unavailable',
    );
    // The record WAS read — the refusal is about recording, not about access — and nothing was returned.
    expect(players.getPlayer).toHaveBeenCalled();
  });
});

describe('*** T026: the SERVICE tier decides independently of the gateway *** (Principle II)', () => {
  it('the handlers declare their required permission for the service-tier guard', () => {
    // Both tiers, and neither trusting the other. The guard reads this metadata from the handler; a call
    // that skips the gateway carries no permission context and is refused by the same guard.
    const reflect = Reflect as unknown as {
      getMetadata(key: string, target: object): unknown;
    };
    const proto = PlayerReadController.prototype as unknown as Record<string, object>;
    expect(reflect.getMetadata('rbac:player_required_permission', proto.getPlayer!)).toBe(
      'crm.contact.view',
    );
    expect(reflect.getMetadata('rbac:player_required_permission', proto.listPlayersByBrand!)).toBe(
      'crm.contact.view',
    );
    // A STAFF read is gated by the inbox permission, not the contact one: reusing the contact key would
    // make one key mean two different things (research R8).
    expect(reflect.getMetadata('rbac:player_required_permission', proto.getOperator!)).toBe(
      'crm.inbox.view',
    );
    // And the routing translation is gated by the ASSIGN key — a third distinct meaning, kept
    // distinct for the same reason: one key covering three questions answers none of them precisely.
    expect(
      reflect.getMetadata('rbac:player_required_permission', proto.listOperatorsByAuthUsers!),
    ).toBe('crm.conversation.assign');
  });

  it('every handler on this controller is permission-gated — derived, not hand-listed', () => {
    // Derived from the prototype so a fourth handler added without a decorator fails here. A hand-written
    // list would let it pass silently, which is the gap feature 016 hit live in the gateway.
    const reflect = Reflect as unknown as { getMetadata(key: string, target: object): unknown };
    const proto = PlayerReadController.prototype as unknown as Record<string, object>;
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    expect(handlers.sort()).toEqual([
      'getOperator',
      'getPlayer',
      // Feature 024 (roadmap 5.3): auth user ids → assignable operator profiles, the group routing
      // pool's translation step. Gated by `crm.conversation.assign` rather than the inbox key: the
      // only reason to ask is to route work, and the answer carries no customer data at all.
      'listOperatorsByAuthUsers',
      'listPersonMembers', // feature 020
      'listPlayersByBrand',
      // W9 / spec 035: the contact lookup — gated by its OWN key (`crm.contact.lookup`), pinned in
      // contact-lookup-gate.spec.ts; the security story lives in ContactLookupService.
      'lookupPlayerByContact',
    ]);
    for (const name of handlers) {
      expect({
        name,
        gated: !!reflect.getMetadata('rbac:player_required_permission', proto[name]!),
      }).toEqual({ name, gated: true });
    }
  });
});
