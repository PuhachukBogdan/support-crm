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
    expect(ROUTES.sort()).toEqual(['getOperator', 'getPlayer', 'listPlayers']);
  });

  it.each(ROUTES)('%s enforces a permission key', (name) => {
    const handler = (PlayersController.prototype as unknown as Record<string, object>)[name]!;
    const enforces = Reflect.getMetadata(REQUIRED_PERMISSION_KEY, handler);
    const resolves = Reflect.getMetadata(RESOLVE_PERMISSIONS_KEY, handler);
    // Either would populate `req.effective`; NEITHER is the defect. Here every route enforces, because the
    // required key is a constant per route (unlike exports, where it depended on a path parameter).
    expect({ name, wired: !!(enforces || resolves) }).toEqual({ name, wired: true });
  });

  it('the customer routes require the contact key and the staff route the inbox key', () => {
    const p = PlayersController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, p.getPlayer!)).toBe('crm.contact.view');
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, p.listPlayers!)).toBe('crm.contact.view');
    // A STAFF read is not a customer-card read. Reusing the contact key would make one key mean two things.
    expect(Reflect.getMetadata(REQUIRED_PERMISSION_KEY, p.getOperator!)).toBe('crm.inbox.view');
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

describe('T048a: the EDGE tier refuses, not only the service', () => {
  it('a downstream refusal maps to a client error without leaking a detail', async () => {
    // The edge tier's own enforcement is the guard's job and is asserted through the metadata above; this
    // covers the other half — that a service-tier refusal reaches the client as a class, never as a message.
    const h = harness({ usersRefuses: true });
    await expect(h.ctl.getPlayer('ply-1', { brandId: 'brand-a' }, h.req)).rejects.toMatchObject({ status: 403 });
  });
});

describe('*** the list query is parsed fail-closed *** (T032)', () => {
  it('accepts exactly the three parameters', () => {
    expect(parseListQuery({ brandId: 'brand-a', pageSize: '25', pageToken: 'abc' })).toEqual({
      brandId: 'brand-a',
      pageSize: 25,
      pageToken: 'abc',
    });
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
    expect(h.recorded.args).toEqual({ brandId: 'brand-a', pageSize: 10, pageToken: '' });
  });
});
