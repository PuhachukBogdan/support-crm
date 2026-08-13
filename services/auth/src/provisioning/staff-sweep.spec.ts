import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import type { RpcException } from '@nestjs/microservices';
import { StaffSweepController } from './staff-sweep.grpc.controller';

/**
 * ⭐ W31 / feature 038 (ADR 0043 §3/§4): the first step of the offboarding sweep.
 *
 * Three properties, because each is a distinct way this could be wrong while looking right: WHO may
 * ask (an actor kind, which no breadth of permission satisfies), HOW MUCH they may ask for (the
 * server decides, not the caller), and WHAT comes back (identifiers only — a list of recently
 * offboarded colleagues is a staffing fact, not a page, and there is no route to it for that reason).
 */

const codeOf = async (p: Promise<unknown>): Promise<number | undefined> => {
  try {
    await p;
    return undefined;
  } catch (err) {
    const detail = (err as RpcException).getError?.() as { code?: number } | undefined;
    return typeof detail?.code === 'number' ? detail.code : undefined;
  }
};

function build(rows: Array<Record<string, unknown>> = []) {
  // Typed args rather than named-and-ignored ones: the clamp assertions below read `mock.calls[0]`,
  // so the tuple is what has to be right, not the implementation's parameter list.
  const listDisabledStaff = jest.fn<Promise<Array<Record<string, unknown>>>, [Date, number]>(
    async () => rows,
  );
  const repo = { listDisabledStaff };
  return { repo, ctl: new StaffSweepController(repo as never) };
}

const system = () => {
  const m = new Metadata();
  m.set('x-actor-kind', 'system');
  return m;
};

/** An administrator's session — every permission this product hands out, and still not enough. */
const admin = () => {
  const m = new Metadata();
  m.set('x-actor-account-id', 'acc-1');
  m.set('x-actor-user-id', 'u-admin');
  m.set('x-actor-permissions', 'users.list.view,platform.settings.manage');
  return m;
};

describe('*** ⭐ the actor KIND is the gate — no permission opens it ***', () => {
  it.each([
    ['an administrator session', admin],
    ['no actor claims at all', () => new Metadata()],
    ['no metadata object at all', () => undefined],
  ])('%s ⇒ PERMISSION_DENIED, and nothing is read', async (_name, md) => {
    const h = build();
    expect(await codeOf(h.ctl.listDisabledStaff({}, md() as never))).toBe(
      GrpcStatus.PERMISSION_DENIED,
    );
    // Refused BEFORE the query: a denial that still ran the read has already done the work it denied.
    expect(h.repo.listDisabledStaff).not.toHaveBeenCalled();
  });

  it('the worker’s own tick is served', async () => {
    const h = build();
    await expect(h.ctl.listDisabledStaff({}, system())).resolves.toEqual({ staff: [] });
  });
});

describe('the batch and the window are the SERVER’s to decide', () => {
  it.each([
    ['nothing asked for', {}, 50, 30],
    ['zeroes', { limit: 0, withinDays: 0 }, 50, 30],
    ['a greedy caller', { limit: 9_999, withinDays: 9_999 }, 200, 365],
    ['nonsense', { limit: -3, withinDays: -3 }, 1, 1],
  ])('%s ⇒ %i rows over %i days', async (_name, req, limit, days) => {
    const h = build();
    await h.ctl.listDisabledStaff(req, system());

    const [since, gotLimit] = h.repo.listDisabledStaff.mock.calls[0]!;
    expect(gotLimit).toBe(limit);
    // The window is what bounds this rpc — there is no «handled» flag to go stale instead, so an
    // unclamped `withinDays` would quietly turn a tick into a full-table scan.
    expect(Math.round((Date.now() - since.getTime()) / 86_400_000)).toBe(days);
  });
});

describe('*** ⭐ the answer carries IDENTIFIERS and nothing else ***', () => {
  it('a row arriving with an address and a name hands on neither', async () => {
    // The repository selects two columns today. This pins the CONTROLLER's own projection, so the
    // guarantee survives somebody widening that select later — which is exactly how a staffing fact
    // turns into a leak: not by a bad decision, by a convenient one somewhere else.
    const h = build([
      { accountId: 'acc-1', userId: 'u-7', email: 'ivan@company.test', fullName: 'Ivan Petrov' },
    ]);
    const res = await h.ctl.listDisabledStaff({ limit: 10 }, system());

    expect(res.staff).toEqual([{ accountId: 'acc-1', userId: 'u-7' }]);
    expect(Object.keys(res.staff[0]!).sort()).toEqual(['accountId', 'userId']);
    const serialised = JSON.stringify(res);
    expect(serialised).not.toContain('@');
    expect(serialised).not.toContain('Ivan');
  });

  it('the read is deliberately NOT account-scoped, and every row says which account it is', async () => {
    const h = build([
      { accountId: 'acc-1', userId: 'u-1' },
      { accountId: 'acc-2', userId: 'u-2' },
    ]);
    const res = await h.ctl.listDisabledStaff({}, system());

    // The sweep that asks belongs to no tenant, so the rows carry their own account for it to pass
    // on — the `ResolveRoutingOperators` shape, and the reason this is a machine rpc with no route.
    expect(res.staff.map((s) => s.accountId)).toEqual(['acc-1', 'acc-2']);
  });
});
