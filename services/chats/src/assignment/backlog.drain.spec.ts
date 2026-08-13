import { Metadata } from '@grpc/grpc-js';
import { BacklogMaintenanceController } from './backlog.grpc.controller';
import type { BacklogItem, BacklogRepository } from './backlog';
import type { GroupPoolService } from './group-pool';
import type { RoundRobinStateRepository } from './round-robin-state.repository';

/**
 * T023/T024/T026 (feature 031, roadmap 4.20 / ADR 0042 §2) — draining the queue.
 *
 * ⚠️ The drain is where two hazards meet: **over-allocation** (two items given the same freed unit) and
 * **head-of-line blocking** (one unservable item stalling everything behind it). Both are asserted here, and
 * neither is visible from the pure queue tests.
 */

const md = (accountId = 'acc-1') => {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u-1');
  return m;
};

const item = (id: string, channel: string | null = 'chat'): BacklogItem => ({
  id,
  channel,
  brand_id: 'b-1',
  routed_group_id: 'g-1',
  backlog_at: new Date(1),
});

const cand = (operatorId: string, capacity = 4, currentLoad = 0) => ({
  operatorId,
  capacity,
  currentLoad,
});

function build(opts: {
  waiting?: BacklogItem[];
  candidates?: ReturnType<typeof cand>[];
  reason?: string | null;
  assignReturns?: (string | null)[];
}) {
  const waiting = jest.fn(async () => opts.waiting ?? []);
  const dequeue = jest.fn(async () => undefined);
  const candidatesFor = jest.fn(async () => ({
    candidates: opts.candidates ?? [cand('op-a')],
    reason: opts.reason ?? null,
  }));
  const answers = [...(opts.assignReturns ?? [])];
  const selectAndAssign = jest.fn(async () => ({
    operatorId: answers.length > 0 ? answers.shift()! : 'op-a',
  }));

  const controller = new BacklogMaintenanceController(
    { waiting, dequeue } as unknown as BacklogRepository,
    { candidatesFor } as unknown as GroupPoolService,
    { selectAndAssign } as unknown as RoundRobinStateRepository,
  );
  return { controller, waiting, dequeue, candidatesFor, selectAndAssign };
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

  it('T026 — every read and write runs under the CALLER’s account (Principle I)', async () => {
    const { controller, waiting, dequeue } = build({ waiting: [item('c-1')] });
    await controller.drainBacklog({ limit: 10 }, md('acc-42'));
    expect(waiting).toHaveBeenCalledWith('acc-42', expect.any(Number));
    expect(dequeue).toHaveBeenCalledWith('acc-42', 'c-1');
  });

  it('the batch is server-capped — a caller cannot ask for the whole queue', async () => {
    const { controller, waiting } = build({ waiting: [] });
    await controller.drainBacklog({ limit: 10_000 }, md());
    expect((waiting.mock.calls[0] as unknown as [string, number])[1]).toBeLessThanOrEqual(100);
  });
});
