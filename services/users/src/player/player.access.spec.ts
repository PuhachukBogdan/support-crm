import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { PlayerReadController } from './player.grpc.controller';

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
  const access = { recordView: jest.fn(async () => undefined), recordBulkRead: jest.fn(async () => undefined) };
  const players = {
    getPlayerById: jest.fn(async (accountId: string, playerId: string) =>
      accountId === 'acc-1' && playerId === 'ply-1'
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
  };
  const operators = {
    getById: jest.fn(async (accountId: string, id: string) =>
      accountId === 'acc-1' && id === 'op-1'
        ? { id: 'op-1', account_id: 'acc-1', display_name: 'Ann', active: false }
        : null,
    ),
  };
  return {
    ctl: new PlayerReadController(players as never, operators as never, access as never),
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
    const wire = (await harness().ctl.getPlayer({ playerId: 'ply-1' }, md())) as Record<string, unknown>;
    expect(wire.playerId).toBe('ply-1');
  });

  it.each([
    ['an unknown id', 'ply-nope', 'acc-1'],
    ['a real id from ANOTHER account', 'ply-1', 'acc-2'],
    ['an empty id', '', 'acc-1'],
  ])('%s → the same NOT_FOUND, status and message', async (_label, id, account) => {
    const res = await failure(harness().ctl.getPlayer({ playerId: id }, md(account)));
    expect(res.code).toBe(GrpcStatus.NOT_FOUND);
    expect(res.message).toBe('not found');
  });

  it('the account always goes INTO the query — it is never compared afterwards', async () => {
    const h = harness();
    await h.ctl.getPlayer({ playerId: 'ply-1' }, md());
    expect(h.players.getPlayerById).toHaveBeenCalledWith('acc-1', 'ply-1');
  });

  it('a missing account context is refused before any read (Principle I)', async () => {
    const h = harness();
    const bare = new Metadata();
    bare.set('x-actor-user-id', 'user-1');
    expect((await failure(h.ctl.getPlayer({ playerId: 'ply-1' }, bare))).code).toBe(
      GrpcStatus.PERMISSION_DENIED,
    );
    expect(h.players.getPlayerById).not.toHaveBeenCalled();
  });

  it('*** a 404 writes NO audit entry — nothing was revealed ***', async () => {
    // The property feature 015's live run recorded for deletions, applied here: no entry filed for a reveal
    // that never happened. Auditing a miss would also make the trail an enumeration oracle of its own.
    const h = harness();
    await failure(h.ctl.getPlayer({ playerId: 'ply-nope' }, md()));
    expect(h.access.recordView).not.toHaveBeenCalled();
  });
});

describe('GetOperator: the same treatment for staff', () => {
  it('an in-account operator returns, with its inactive state visible', async () => {
    // Returned rather than filtered on: a name still has to render on last year's conversations.
    const wire = (await harness().ctl.getOperator({ operatorId: 'op-1' }, md())) as Record<string, unknown>;
    expect(wire).toEqual({ operatorId: 'op-1', accountId: 'acc-1', displayName: 'Ann', active: false });
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
    .map((f) => ({ name: `player/${f}`, src: readFileSync(join(ROOT, 'services', 'users', 'src', 'player', f), 'utf8') }))
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
      getPlayerById: jest.fn(async () => ({
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
    };
    const access = {
      recordView: jest.fn(async () => {
        throw new Error('audit table unavailable');
      }),
      recordBulkRead: jest.fn(),
    };
    const ctl = new PlayerReadController(players as never, { getById: jest.fn() } as never, access as never);

    await expect(ctl.getPlayer({ playerId: 'ply-1' }, md())).rejects.toThrow('audit table unavailable');
    // The record WAS read — the refusal is about recording, not about access — and nothing was returned.
    expect(players.getPlayerById).toHaveBeenCalled();
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
    expect(reflect.getMetadata('rbac:player_required_permission', proto.getPlayer!)).toBe('crm.contact.view');
    expect(reflect.getMetadata('rbac:player_required_permission', proto.listPlayersByBrand!)).toBe(
      'crm.contact.view',
    );
    // A STAFF read is gated by the inbox permission, not the contact one: reusing the contact key would
    // make one key mean two different things (research R8).
    expect(reflect.getMetadata('rbac:player_required_permission', proto.getOperator!)).toBe('crm.inbox.view');
  });

  it('every handler on this controller is permission-gated — derived, not hand-listed', () => {
    // Derived from the prototype so a fourth handler added without a decorator fails here. A hand-written
    // list would let it pass silently, which is the gap feature 016 hit live in the gateway.
    const reflect = Reflect as unknown as { getMetadata(key: string, target: object): unknown };
    const proto = PlayerReadController.prototype as unknown as Record<string, object>;
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    expect(handlers.sort()).toEqual(['getOperator', 'getPlayer', 'listPlayersByBrand']);
    for (const name of handlers) {
      expect({
        name,
        gated: !!reflect.getMetadata('rbac:player_required_permission', proto[name]!),
      }).toEqual({ name, gated: true });
    }
  });
});
