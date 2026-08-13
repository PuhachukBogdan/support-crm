import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import {
  REQUIRED_PERMISSION_KEY,
  RESOLVE_PERMISSIONS_KEY,
  REQUIRES_SCOPE_PARAM_KEY,
} from '../security/requires-permission.decorator';
import { PlayersController } from './players.controller';
import { parseListQuery, parsePageSize } from './wire';

/**
 * T031 / T032 / T048 / T048a (feature 018) — the edge.
 *
 * The first block is the one feature 016 paid for live: the guard populates the caller's resolved
 * permissions **only** for routes carrying permission metadata, and the metadata builder reads exactly
 * that. A route without a decorator forwards an EMPTY permission set and the owning service correctly
 * refuses everything — both tiers individually right, the wire between them wrong, invisible to any
 * Track-A spec that mocks the client.
 *
 * The route list is DERIVED from the controller. 016's own version enumerated three names by hand, so a
 * fourth route added without a decorator **and** without being added to the list would have passed
 * silently — the same gap in a new place.
 */
const CLAIMS = { accountId: 'acc-1', userId: 'user-1', roles: ['am'] };

const effective = (over: Record<string, unknown> = {}) => ({
  roleKey: 'am',
  permissionKeys: ['crm.contact.view', 'crm.inbox.view'],
  mode: 'inherited' as const,
  isPreview: false,
  readOnly: false,
  ...over,
});

function harness(opts: { usersRefuses?: boolean } = {}) {
  const recorded: { meta?: unknown; args?: Record<string, unknown> } = {};
  const svc = {
    getPlayer: jest.fn((d: Record<string, unknown>, md: unknown) => {
      recorded.args = d;
      recorded.meta = md;
      if (opts.usersRefuses) return throwError(() => ({ code: 7, message: 'forbidden' }));
      return of({ playerId: 'ply-1', accountId: 'acc-1', brandIds: ['brand-a'] });
    }),
    listPlayersByBrand: jest.fn((d: Record<string, unknown>, md: unknown) => {
      recorded.args = d;
      recorded.meta = md;
      return of({ players: [], nextPageToken: '' });
    }),
    getOperator: jest.fn((d: Record<string, unknown>, md: unknown) => {
      recorded.args = d;
      recorded.meta = md;
      return of({ operatorId: 'op-1', accountId: 'acc-1', displayName: 'Ann', active: true });
    }),
    // ⭐ 2026-08-10 — answers with the proto's ENUM NUMBER, as the real rpc does. A stub that
    // returned the word would hide the decode this edge exists to perform.
    listOperatorsByAuthUsers: jest.fn((d: Record<string, unknown>, md: unknown) => {
      recorded.args = d;
      recorded.meta = md;
      return of({
        operators: [
          { operatorId: 'op-1', authUserId: 'u-1', state: 1, blockedChannels: [] },
          { operatorId: 'op-2', authUserId: 'u-2', state: 3, blockedChannels: ['email'] },
        ],
      });
    }),
  };
  const ctl = new PlayersController({ getService: () => svc } as never);
  ctl.onModuleInit();
  const req = { claims: CLAIMS, effective: effective() } as never;
  return { ctl, svc, req, recorded };
}

describe('*** every route carries permission metadata *** (the 016 wire defect, derived not listed)', () => {
  const ROUTES = Object.getOwnPropertyNames(PlayersController.prototype).filter(
    (n) => n !== 'constructor' && n !== 'onModuleInit' && !n.startsWith('meta'),
  );

  it('the scan sees the real routes (guards against a vacuous pass)', () => {
    // ⓘ W35's notes routes are NOT here and must not be: this controller is the read edge, and
    // `tests/users-read/no-outbound.spec.ts` asserts every verb in its file is a `Get`. The notes
    // surface has its own controller and its own key assertions (`notes-edge.spec.ts`).
    expect(ROUTES.sort()).toEqual(['getOperator', 'getPlayer', 'listOperators', 'listPlayers']);
  });

  it.each(ROUTES)('%s enforces a permission key', (name) => {
    const handler = (PlayersController.prototype as unknown as Record<string, object>)[name]!;
    const enforces = Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler);
    const resolves = Reflect.getMetadata(RESOLVE_PERMISSIONS_KEY, handler);
    // Either would populate `req.effective`; NEITHER is the defect. Here every route enforces, because the
    // required key is a constant per route (unlike exports, where it depended on a path parameter).
    expect({ name, wired: !!(enforces || resolves) }).toEqual({ name, wired: true });
  });

  it('one customer at a time is the contact key; BROWSING them all is its own', () => {
    const p = PlayersController.prototype as unknown as Record<string, object>;
    // Reading the card of a customer you are already working with…
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, p.getPlayer!)).toBe('crm.contact.view');
    /**
     * ⭐ …is not the same act as paging the whole base. Q34's answer (2026-08-06) made the
     * directory's entitlement explicit: VIP support, AM, Shift AM and teamlead hold
     * `crm.customers.browse`; a line agent does not and reaches a customer through their ticket.
     * Until then the rule lived as a TIER comparison inside `users` that no rail entry could ask
     * about, so the screen was hidden from people the server was willing to serve.
     */
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, p.listPlayers!)).toBe('crm.customers.browse');
    // A STAFF read is not a customer-card read. Reusing the contact key would make one key mean two things.
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, p.getOperator!)).toBe('crm.inbox.view');
    /**
     * ⭐⭐ 2026-08-10 — and the LIST carries the rpc's OWN key, not the read-one key beside it.
     *
     * ⚠️ This is the assertion that keeps the edge from laundering a permission. The rpc is gated on
     * `crm.conversation.assign` and its comment states the rule outright: *"the caller forwards its
     * own credentials unchanged; calling as a system actor would launder the permission."* Putting
     * `crm.inbox.view` here — the key its neighbour uses — would hand every inbox reader the staffing
     * answer, through a route that looks like a sibling of one that was reviewed.
     */
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, p.listOperators!)).toBe(
      'crm.conversation.assign',
    );
  });

  it('no route uses the scope-parameter form — the key here is not parameter-dependent', () => {
    for (const name of ROUTES) {
      const handler = (PlayersController.prototype as unknown as Record<string, object>)[name]!;
      expect(Reflect.getMetadata(REQUIRES_SCOPE_PARAM_KEY, handler)).toBeUndefined();
    }
  });
});

describe('*** the two new headers reach the owning service ***', () => {
  it('the effective role and the identity are forwarded', async () => {
    const h = harness();
    await h.ctl.getPlayer('ply-1', { brandId: 'brand-a' }, h.req);
    const md = h.recorded.meta as { get(k: string): unknown[] };
    expect(md.get('x-actor-account-id')[0]).toBe('acc-1');
    expect(md.get('x-actor-user-id')[0]).toBe('user-1');
    expect(md.get('x-actor-permissions')[0]).toBe('crm.contact.view,crm.inbox.view');
    // The masking input. Without it the owning service falls back to the most restricted tier and the
    // caller silently sees less than they should — a failure that looks like a permissions problem.
    expect(md.get('x-actor-effective-role')[0]).toBe('am');
  });

  it('the PREVIEWED role is what travels under view-as', async () => {
    const h = harness();
    const previewing = { claims: CLAIMS, effective: effective({ roleKey: 'support_agent', isPreview: true }) } as never;
    await h.ctl.getPlayer('ply-1', { brandId: 'brand-a' }, previewing);
    const md = h.recorded.meta as { get(k: string): unknown[] };
    expect(md.get('x-actor-effective-role')[0]).toBe('support_agent');
    expect(md.get('x-is-preview')[0]).toBe('true');
    // …while the identity headers still name the real caller.
    expect(md.get('x-actor-user-id')[0]).toBe('user-1');
  });

  it('*** never an EMPTY permission set *** (016 live defect)', async () => {
    const h = harness();
    await h.ctl.getPlayer('ply-1', { brandId: 'brand-a' }, h.req);
    const md = h.recorded.meta as { get(k: string): unknown[] };
    expect(String(md.get('x-actor-permissions')[0] ?? '')).not.toBe('');
  });
});

/**
 * ⭐⭐ 2026-08-10 — `GET /operators?authUserIds=…`, the ticket window's Assignee chooser.
 *
 * The operator, on the shipped screen: *«я всё ещё не вижу возможности менять поля типа бренд,
 * ассайни»*. Assignee had no editor because the browser had no way to learn who is assignable: the
 * rpc that answers it has existed since feature 024 and was reachable from nowhere outside the
 * cluster — *a contract with no caller is indistinguishable from an unbuilt one*.
 */
describe('*** the assignable-operator translation ***', () => {
  it('forwards exactly the ids asked for, trimmed, and nothing else', async () => {
    const h = harness();
    await h.ctl.listOperators(' u-1 , u-2 ,', h.req);
    expect(h.recorded.args).toEqual({ authUserIds: ['u-1', 'u-2'] });
    // The caller's own credentials, unchanged — the rule the rpc's comment states. A system-actor
    // call here would launder the permission the route just enforced.
    const md = h.recorded.meta as { get(k: string): unknown[] };
    expect(md.get('x-actor-user-id')[0]).toBe('user-1');
  });

  it('decodes the presence ENUM to the closed set of words', async () => {
    const h = harness();
    const res = await h.ctl.listOperators('u-1,u-2', h.req);
    expect(res.operators).toEqual([
      { operatorId: 'op-1', authUserId: 'u-1', state: 'online', blockedChannels: [] },
      { operatorId: 'op-2', authUserId: 'u-2', state: 'away', blockedChannels: ['email'] },
    ]);
  });

  it('⚠️ an UNRECOGNISED state decodes to `offline` — fail-closed, never "available"', async () => {
    const h = harness();
    (h.svc.listOperatorsByAuthUsers as jest.Mock).mockReturnValueOnce(
      of({ operators: [{ operatorId: 'op-9', authUserId: 'u-9', state: 99 }] }),
    );
    const res = await h.ctl.listOperators('u-9', h.req);
    /**
     * A state this product has not heard of must read as *not taking work*. Defaulting to `online`
     * would put a colleague forward as available on the strength of a number nobody recognised —
     * the same fail-closed rule the rpc applies to a missing operator profile.
     */
    expect(res.operators[0]!.state).toBe('offline');
    expect(res.operators[0]!.blockedChannels).toEqual([]);
  });

  it('⛔ an ABSENT list is a 400 — never "everyone"', async () => {
    const h = harness();
    // The rpc translates a list; there is no "all operators" question in the contract, so a default
    // here would mean inventing one in the tier forbidden to hold business logic (Principle VIII).
    await expect(h.ctl.listOperators(undefined, h.req)).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.ctl.listOperators('  ,  ', h.req)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.svc.listOperatorsByAuthUsers).not.toHaveBeenCalled();
  });

  it('⛔ and an unbounded one is a 400 too — the bound is restated, not assumed from the caller', async () => {
    const h = harness();
    const many = Array.from({ length: 201 }, (_, i) => `u-${i}`).join(',');
    await expect(h.ctl.listOperators(many, h.req)).rejects.toBeInstanceOf(BadRequestException);
    expect(h.svc.listOperatorsByAuthUsers).not.toHaveBeenCalled();
  });

  it('⚠️ the response is RESTATED field by field — a new rpc field cannot reach the browser', async () => {
    const h = harness();
    (h.svc.listOperatorsByAuthUsers as jest.Mock).mockReturnValueOnce(
      of({
        operators: [
          // A field a future feature adds to the rpc. It must not travel by accident: this edge is
          // one hop from the browser, and `me/operator` states the same rule one file over.
          { operatorId: 'op-1', authUserId: 'u-1', state: 1, secretStaffingNote: 'do not send' },
        ],
      }),
    );
    const res = await h.ctl.listOperators('u-1', h.req);
    expect(Object.keys(res.operators[0]!).sort()).toEqual([
      'authUserId',
      'blockedChannels',
      'operatorId',
      'state',
    ]);
  });
});

describe('T048a: the EDGE tier refuses, not only the service', () => {
  it('a downstream refusal maps to a client error without leaking a detail', async () => {
    // The edge tier's own enforcement is the guard's job and is asserted through the metadata above; this
    // covers the other half — that a service-tier refusal reaches the client as a class, never as a message.
    const h = harness({ usersRefuses: true });
    await expect(h.ctl.getPlayer('ply-1', { brandId: 'brand-a' }, h.req)).rejects.toMatchObject({ status: 403 });
  });
});

describe('*** the list query is parsed fail-closed *** (T032)', () => {
  it('accepts exactly the FOUR parameters (W11 added the id prefix)', () => {
    expect(parseListQuery({ brandId: 'brand-a', pageSize: '25', pageToken: 'abc' })).toEqual({
      brandId: 'brand-a',
      pageSize: 25,
      pageToken: 'abc',
      // Absent search ⇒ `''`, so nothing narrows.
      playerIdPrefix: '',
    });
    expect(parseListQuery({ brandId: 'brand-a', playerIdPrefix: ' ply-47 ' })).toMatchObject({
      playerIdPrefix: 'ply-47',
    });
  });

  it('⛔ W11: there is NO contact parameter on the directory, and adding one is a 400', () => {
    // Searching by email or phone is the anti-pitching inversion and lives ONLY inside an
    // unidentified conversation (ADR 0044 §4). A directory that accepted it would be exactly the
    // "player database with a search box" that decision forbids — so these are unknown keys.
    for (const key of ['email', 'phone', 'contact', 'q']) {
      expect(() => parseListQuery({ brandId: 'b', [key]: 'x' })).toThrow(BadRequestException);
    }
  });

  it('W11: an over-long prefix is REFUSED, never truncated', () => {
    // A truncated search returns rows the caller did not ask about, and an unbounded value on a
    // `startsWith` is a free scan of an indexed column.
    expect(() => parseListQuery({ brandId: 'b', playerIdPrefix: 'x'.repeat(65) })).toThrow(
      BadRequestException,
    );
  });

  it('*** brandId is REQUIRED — an unfiltered read is not an operation ***', () => {
    // Defaulting a missing brand to "all" would be the widening direction in its purest form: a request for
    // one brand's customers quietly becoming a request for every customer in the account.
    expect(() => parseListQuery({})).toThrow(BadRequestException);
    expect(() => parseListQuery({ brandId: '   ' })).toThrow(BadRequestException);
  });

  it('an unknown query parameter is REFUSED, never ignored', () => {
    expect(() => parseListQuery({ brandId: 'b', vip: 'true' })).toThrow(BadRequestException);
    expect(() => parseListQuery({ brandId: 'b', brnad: 'typo' })).toThrow(BadRequestException);
  });

  it('the refusal names the KEY and never echoes the value (SEC-26)', () => {
    try {
      parseListQuery({ brandId: 'b', secretish: 'ply-4711' });
      throw new Error('should have refused');
    } catch (err) {
      const message = (err as BadRequestException).message;
      expect(message).toContain('secretish');
      expect(message).not.toContain('ply-4711');
    }
  });

  it('pageSize nonsense is a 400, never a silent default', () => {
    for (const bad of ['all', '0', '-5', '1.5', 'NaN']) {
      expect(() => parsePageSize(bad)).toThrow(BadRequestException);
    }
    // Absent means "let the service decide", which is a different thing from "invalid".
    expect(parsePageSize(undefined)).toBe(0);
    expect(parsePageSize('')).toBe(0);
  });

  it('the parsed values are what reach the service', async () => {
    const h = harness();
    await h.ctl.listPlayers({ brandId: 'brand-a', pageSize: '10' }, h.req);
    expect(h.recorded.args).toEqual({
      brandId: 'brand-a',
      pageSize: 10,
      pageToken: '',
      playerIdPrefix: '',
    });
  });
});
