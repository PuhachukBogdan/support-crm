import { Metadata } from '@grpc/grpc-js';
import { BacklogMaintenanceController } from './backlog.grpc.controller';
import type { BacklogRepository } from './backlog';
import type { BacklogSweepRepository } from './backlog-sweep.repository';
import type { GroupPoolService } from './group-pool';
import type { RoundRobinStateRepository } from './round-robin-state.repository';
import type { AuditRepository } from '../audit/audit.repository';

/**
 * T023/T024/T026 (feature 031, roadmap 4.20 / ADR 0042 §2) — draining the queue.
 *
 * ⚠️ The drain is where two hazards meet: **over-allocation** (two items given the same freed unit) and
 * **head-of-line blocking** (one unservable item stalling everything behind it). Both are asserted here, and
 * neither is visible from the pure queue tests.
 */

/**
 * ⚠️ The caller is a MACHINE, and this fixture is the correction.
 *
 * It used to set `x-actor-account-id` + `x-actor-user-id`, and the drain read its account from there.
 * The worker's tick can set neither: a periodic job belongs to no tenant and no person. Every assertion
 * in this file passed while the live drain threw `PERMISSION_DENIED` on every tick — a hermetic test that
 * invents a caller shape production cannot produce proves the code works for a caller that does not exist.
 */
const md = () => {
  const m = new Metadata();
  m.set('x-actor-kind', 'system');
  return m;
};

const item = (id: string, channel: string | null = 'chat', accountId = 'acc-1') => ({
  account_id: accountId,
  id,
  channel,
  brand_id: 'b-1',
  routed_group_id: 'g-1',
  backlog_at: new Date(1),
});
type Waiting = ReturnType<typeof item>;

const cand = (operatorId: string, capacity = 4, currentLoad = 0) => ({
  operatorId,
  capacity,
  currentLoad,
});

function build(opts: {
  waiting?: Waiting[];
  candidates?: ReturnType<typeof cand>[];
  reason?: string | null;
  assignReturns?: (string | null)[];
}) {
  const waitingAcrossAccounts = jest.fn(async () => opts.waiting ?? []);
  const dequeue = jest.fn(async () => undefined);
  // Typed with the arguments the assertions read back (the account and the metadata it was given).
  const candidatesFor = jest.fn(
    async (accountId: string, groupId: string, metadata: Metadata, ...rest: unknown[]) => {
      void groupId;
      void metadata;
      void rest;
      void accountId;
      return { candidates: opts.candidates ?? [cand('op-a')], reason: opts.reason ?? null };
    },
  );
  const answers = [...(opts.assignReturns ?? [])];
  const selectAndAssign = jest.fn(async () => ({
    operatorId: answers.length > 0 ? answers.shift()! : 'op-a',
  }));

  // Typed so the assertions can read the entry the drain built.
  const append = jest.fn(async (accountId: string, entry: Record<string, unknown>) => {
    void accountId;
    void entry;
  });
  const controller = new BacklogMaintenanceController(
    { dequeue } as unknown as BacklogRepository,
    { waitingAcrossAccounts } as unknown as BacklogSweepRepository,
    { candidatesFor } as unknown as GroupPoolService,
    { selectAndAssign } as unknown as RoundRobinStateRepository,
    { append } as unknown as AuditRepository,
  );
  return {
    controller,
    waiting: waitingAcrossAccounts,
    dequeue,
    candidatesFor,
    selectAndAssign,
    append,
  };
}

describe('draining the backlog', () => {
  it('assigns what fits and takes it out of the queue', async () => {
    const { controller, dequeue } = build({ waiting: [item('c-1')] });

    const res = await controller.drainBacklog({ limit: 10 }, md());

    expect(res).toMatchObject({ considered: 1, assigned: 1, skipped: 0, unroutable: 0 });
    expect(dequeue).toHaveBeenCalledTimes(1);
  });

  it('⭐ POSITIVE CONTROL: an item nobody can serve is SKIPPED and stays queued', async () => {
    // Without this, "assigned: 1" above is satisfied by a drain that assigns everything regardless.
    const { controller, dequeue } = build({
      waiting: [item('c-voice', 'voice')],
      candidates: [cand('op-a', 4, 2)], // has room, but not the whole person a voice call needs
    });

    const res = await controller.drainBacklog({ limit: 10 }, md());

    expect(res).toMatchObject({ assigned: 0, skipped: 1 });
    expect(dequeue).not.toHaveBeenCalled();
  });

  it('⚠️ re-reads capacity for EVERY item, not once for the batch', async () => {
    // The first assignment consumes a unit. A batch-level snapshot would hand the same freed slot to
    // several conversations — the over-allocation R8 exists to prevent, arriving by the back door.
    const { controller, candidatesFor } = build({ waiting: [item('c-1'), item('c-2'), item('c-3')] });

    await controller.drainBacklog({ limit: 10 }, md());

    expect(candidatesFor).toHaveBeenCalledTimes(3);
  });

  it('⭐ head-of-line: an unservable item does not stop the ones behind it', async () => {
    const { controller, dequeue } = build({
      waiting: [item('c-voice', 'voice'), item('c-chat')],
      candidates: [cand('op-a', 4, 1)],
    });

    const res = await controller.drainBacklog({ limit: 10 }, md());

    expect(res).toMatchObject({ assigned: 1, skipped: 1 });
    // …and the one that moved is the chat, not the voice call.
    expect(dequeue).toHaveBeenCalledWith('acc-1', 'c-chat');
  });

  it('a desk that is not a queue counts as unroutable and keeps its place', async () => {
    const { controller, dequeue, selectAndAssign } = build({
      waiting: [item('c-1')],
      reason: 'DESK_NOT_ROUTABLE',
    });

    const res = await controller.drainBacklog({ limit: 10 }, md());

    expect(res).toMatchObject({ assigned: 0, unroutable: 1 });
    expect(selectAndAssign).not.toHaveBeenCalled();
    expect(dequeue).not.toHaveBeenCalled();
  });

  it('⚠️ losing the race is a SKIP, not an error — the next drain tries again', async () => {
    // It fitted a moment ago and does not now: somebody else took the slot. The item stays queued.
    const { controller, dequeue } = build({ waiting: [item('c-1')], assignReturns: [null] });

    const res = await controller.drainBacklog({ limit: 10 }, md());

    expect(res).toMatchObject({ assigned: 0, skipped: 1 });
    expect(dequeue).not.toHaveBeenCalled();
  });

  it('an empty queue is a no-op, not an error', async () => {
    const { controller } = build({ waiting: [] });
    await expect(controller.drainBacklog({ limit: 10 }, md())).resolves.toMatchObject({
      considered: 0,
      assigned: 0,
    });
  });

  it('⛔ answers COUNTS ONLY — no conversation id reaches a maintenance response', async () => {
    // A drain that named conversations would put customer work into a response that is logged and
    // graphed by people not looking at it with customer eyes (Principle IV).
    const { controller } = build({ waiting: [item('c-secret')] });
    const res = await controller.drainBacklog({ limit: 10 }, md());
    expect(JSON.stringify(res)).not.toContain('c-secret');
    expect(Object.keys(res).sort()).toEqual(['assigned', 'considered', 'skipped', 'unroutable']);
  });

  it('⭐ T026 — every write runs under the account OF THE ROW, not of the caller (Principle I)', async () => {
    // The correction, asserted: the account comes from the data, because the caller has none. Two
    // accounts in one batch is the case that makes the difference visible — a drain that took its
    // account from the caller would put one account's work under the other's scope.
    const { controller, dequeue, candidatesFor } = build({
      waiting: [item('c-1', 'chat', 'acc-1'), item('c-2', 'chat', 'acc-42')],
    });

    await controller.drainBacklog({ limit: 10 }, md());

    expect(dequeue).toHaveBeenCalledWith('acc-1', 'c-1');
    expect(dequeue).toHaveBeenCalledWith('acc-42', 'c-2');
    // …and the desk was resolved under each row's own account too.
    expect(candidatesFor.mock.calls.map((c) => c[0])).toEqual([
      'acc-1',
      'acc-42',
    ]);
  });

  it('⛔ a USER session cannot drain, however broad its permissions', async () => {
    // A cross-account path must be unreachable from a session even when it answers only counts — feature
    // 014's rule for the SLA sweep. The first version of this handler had no such check: it was scoped to
    // whoever called it, so the gate was an accident of reading the account from the caller.
    const { controller } = build({ waiting: [item('c-1')] });
    const user = new Metadata();
    user.set('x-actor-account-id', 'acc-1');
    user.set('x-actor-user-id', 'u-1');
    user.set('x-actor-permissions', 'crm.conversation.assign,platform.audit.view');
    await expect(controller.drainBacklog({ limit: 10 }, user)).rejects.toBeDefined();
  });

  it('⛔ the desk is consulted with SYSTEM metadata carrying no permissions', async () => {
    // A machine that granted itself `crm.conversation.assign` would be laundering a human's permission.
    const { controller, candidatesFor } = build({ waiting: [item('c-1')] });
    await controller.drainBacklog({ limit: 10 }, md());
    const passed = candidatesFor.mock.calls[0]![2];
    expect(passed.get('x-actor-kind')[0]).toBe('system');
    expect(passed.get('x-actor-account-id')[0]).toBe('acc-1');
    expect(passed.get('x-actor-permissions')).toEqual([]);
    expect(passed.get('x-actor-user-id')).toEqual([]);
  });

  it('the batch is server-capped — a caller cannot ask for the whole queue', async () => {
    const { controller, waiting } = build({ waiting: [] });
    await controller.drainBacklog({ limit: 10_000 }, md());
    expect((waiting.mock.calls[0] as unknown as [number])[0]).toBeLessThanOrEqual(100);
  });

  it('⭐ T033/T034 unroutable work raises exactly ONE audited event, with a reason CLASS', async () => {
    const { controller, append } = build({ waiting: [item('c-1')], reason: 'DESK_NOT_ROUTABLE' });

    await controller.drainBacklog({ limit: 10 }, md());

    expect(append).toHaveBeenCalledTimes(1);
    const entry = append.mock.calls[0]![1] as Record<string, unknown>;
    expect(entry.action).toBe('conversation.unroutable');
    expect(entry.actorKind).toBe('system');
    expect(entry.detail).toMatchObject({ reasonClass: 'desk_not_routable' });
  });

  it('⛔ the event carries a CLASS, never a sentence or a customer', async () => {
    // The class is what an administrator can act on: "the desk is not a queue" is a checkbox, "nobody is
    // available" is a rota. A relay's wording or a contact value must be inexpressible here.
    const { controller, append } = build({ waiting: [item('c-1')], reason: 'GROUP_ROUTING_NOT_AVAILABLE' });
    await controller.drainBacklog({ limit: 10 }, md());
    const entry = append.mock.calls[0]![1] as { detail: Record<string, unknown> };
    expect(Object.keys(entry.detail)).toEqual(['reasonClass']);
    expect(entry.detail.reasonClass).toBe('nobody_available');
  });

  it('⭐ POSITIVE CONTROL: work that IS routable raises no event at all', async () => {
    // Without this, "one event" is satisfied by a drain that alarms about everything.
    const { controller, append } = build({ waiting: [item('c-1')] });
    await controller.drainBacklog({ limit: 10 }, md());
    expect(append).not.toHaveBeenCalled();
  });
});
