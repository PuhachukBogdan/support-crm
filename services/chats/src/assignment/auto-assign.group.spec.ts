import { Metadata } from '@grpc/grpc-js';
import type { PrismaService } from '../prisma.service';
import { ConversationRepository } from '../conversation/conversation.repository';
import { RoundRobinStateRepository } from './round-robin-state.repository';
import { TransitionRecorder } from '../transition/transition.recorder';
import type { GroupPoolService } from './group-pool';
import type { BacklogRepository } from './backlog';
import type { RoundRobinCandidate } from './round-robin';
import { fakeStatusRepository } from '../status/status.fixture';
import {
  AutoAssignController,
  GROUP_ROUTING_NOT_AVAILABLE,
  NO_OPERATOR_AVAILABLE,
} from './auto-assign.grpc.controller';

/**
 * US3 (feature 024, roadmap 5.3) — auto-assignment driven by a GROUP.
 *
 * This converts feature 013's honest placeholder into the real thing. What it must NOT do is change
 * anything the placeholder guaranteed, so the two outcomes it defined are re-asserted here against
 * the new path: nobody available, and group routing not resolvable. `auto-assign.spec.ts` keeps
 * proving the caller-supplied path, unchanged, through a pool stub that throws if consulted.
 */

const conversationRow = (over: Record<string, unknown> = {}) => ({
  id: 'c1',
  brand_id: 'brand-a',
  player_id: 'p1',
  status: 'open',
  priority: null,
  assignee_operator_id: null,
  channel: null,
  reference: null,
  category: null,
  sub_category: null,
  classified_by: null,
  subject: null,
  subject_source: 'auto',
  routed_group_id: null,
  created_at: new Date('2026-08-05T10:00:00.000Z'),
  updated_at: new Date('2026-08-05T10:00:00.000Z'),
  ...over,
});

function fakePrisma() {
  const conversation = {
    findFirst: jest.fn().mockResolvedValue(conversationRow()),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    // Feature 031: what the chosen operator is holding, re-read inside the lock. Empty = a fresh desk.
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
  };
  const roundRobinState = {
    findFirst: jest.fn().mockResolvedValue(null),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    create: jest.fn().mockResolvedValue({ id: 'rr1' }),
  };
  const conversationTransition = { create: jest.fn() };
  // Feature 031: the per-operator advisory lock the claim takes before re-reading the load. A fake
  // that omitted it would make every assignment throw — which is how the real one is proven to run.
  const executeRawUnsafe = jest.fn(async () => 1);
  const scoped = {
    conversation,
    roundRobinState,
    conversationTransition,
    $executeRawUnsafe: executeRawUnsafe,
  } as Record<string, unknown>;
  scoped.$transaction = jest.fn(function (this: unknown, cb: (tx: unknown) => unknown) {
    if (this !== scoped) throw new TypeError('$transaction lost its binding');
    return cb(scoped);
  });
  const forAccount = jest.fn().mockReturnValue(scoped);
  return {
    prisma: { forAccount } as unknown as PrismaService,
    conversation,
    roundRobinState,
    conversationTransition,
    forAccount,
  };
}

const md = (accountId = 'acc-1') => {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
  m.set('x-actor-permissions', 'crm.conversation.assign');
  return m;
};

const cand = (operatorId: string, capacity = 5, currentLoad = 0): RoundRobinCandidate => ({
  operatorId,
  capacity,
  currentLoad,
});

function build(prisma: PrismaService, candidates: RoundRobinCandidate[] | Error) {
  const candidatesFor = jest.fn(async () => {
    if (candidates instanceof Error) throw candidates;
    // Feature 031: the pool answers WHY it is empty. `reason: null` = resolved normally, even when it
    // resolved to nobody — the not-routable case is its own spec, where it is the subject.
    return { candidates, reason: null };
  });
  const controller = new AutoAssignController(
    new RoundRobinStateRepository(prisma, new TransitionRecorder(), fakeStatusRepository()),
    new ConversationRepository(prisma, new TransitionRecorder()),
    { candidatesFor } as unknown as GroupPoolService,
    {
      enqueue: jest.fn(async () => undefined),
      dequeue: jest.fn(async () => undefined),
      waiting: jest.fn(async () => []),
    } as unknown as BacklogRepository,
  );
  return { controller, candidatesFor };
}

describe('AutoAssignConversation — the pool comes from a group', () => {
  it('assigns someone from the named group', async () => {
    const { prisma, conversation } = fakePrisma();
    const { controller, candidatesFor } = build(prisma, [cand('op-a'), cand('op-b')]);

    const res = await controller.autoAssignConversation(
      { conversationId: 'c1', groupId: 'grp-payments' },
      md(),
    );

    expect(res.assigned).toBe(true);
    expect(['op-a', 'op-b']).toContain(res.operatorId);
    // Feature 025 (roadmap 5.9) added a fourth argument: the conversation's own channel, which is
    // what a per-channel availability switch is matched against. `null` here because this fixture's
    // conversation has no channel recorded — the case feature 022 keeps distinct from every channel
    // NAME, and which the availability predicate answers at state level alone.
    // Feature 031: the brand travels with the request too — the unit budget is per brand.
    expect(candidatesFor).toHaveBeenCalledWith(
      'acc-1',
      'grp-payments',
      expect.anything(),
      null,
      expect.anything(),
    );
    // The desk is recorded in the SAME write as the assignee, so the two can never disagree.
    expect(conversation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ routed_group_id: 'grp-payments' }),
      }),
    );
  });

  it('rotates fairly over the group, exactly as it does over a supplied list (FR-023)', async () => {
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { prisma, roundRobinState } = fakePrisma();
      roundRobinState.findFirst.mockResolvedValue({ id: 'rr1', cursor: i - 1 });
      const { controller } = build(prisma, [cand('op-a'), cand('op-b'), cand('op-c')]);
      const res = await controller.autoAssignConversation(
        { conversationId: 'c1', groupId: 'g-1' },
        md(),
      );
      picks.push(res.operatorId);
    }
    // Even within one over six assignments across three people — the property feature 013 proved,
    // now over a pool this feature built rather than one the caller typed.
    for (const op of ['op-a', 'op-b', 'op-c']) {
      expect(picks.filter((p) => p === op).length).toBe(2);
    }
  });

  it('keys the rotation on the GROUP, so two desks cannot advance each other’s cursor', async () => {
    const { prisma, roundRobinState } = fakePrisma();
    const { controller } = build(prisma, [cand('op-a')]);
    await controller.autoAssignConversation({ conversationId: 'c1', groupId: 'g-payments' }, md());
    expect(roundRobinState.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ group_key: 'g-payments' }) }),
    );
  });

  it('an empty group answers GROUP_ROUTING_NOT_AVAILABLE and assigns nobody', async () => {
    const { prisma, conversation } = fakePrisma();
    const { controller } = build(prisma, []);

    const res = await controller.autoAssignConversation(
      { conversationId: 'c1', groupId: 'g-empty' },
      md(),
    );

    // Unchanged from feature 013: a guess is worse than a truthful "not yet" (US3 #4).
    expect(res).toMatchObject({ assigned: false, operatorId: '', reason: GROUP_ROUTING_NOT_AVAILABLE });
    expect(conversation.updateMany).not.toHaveBeenCalled();
  });

  it('everyone at capacity answers NO_OPERATOR_AVAILABLE and leaves the cursor alone', async () => {
    const { prisma, conversation, roundRobinState } = fakePrisma();
    const { controller } = build(prisma, [cand('op-a', 1, 1), cand('op-b', 2, 5)]);

    const res = await controller.autoAssignConversation(
      { conversationId: 'c1', groupId: 'g-1' },
      md(),
    );

    expect(res).toMatchObject({ assigned: false, reason: NO_OPERATOR_AVAILABLE });
    expect(conversation.updateMany).not.toHaveBeenCalled();
    expect(roundRobinState.updateMany).not.toHaveBeenCalled();
    expect(roundRobinState.create).not.toHaveBeenCalled();
  });

  it('a group id WINS and the supplied candidates are ignored — not merged', async () => {
    // Two sources for one routing answer is how a routing decision becomes unexplainable.
    const { prisma } = fakePrisma();
    const { controller, candidatesFor } = build(prisma, [cand('from-group')]);

    const res = await controller.autoAssignConversation(
      {
        conversationId: 'c1',
        groupId: 'g-1',
        candidates: [{ operatorId: 'from-caller', capacity: 9, currentLoad: 0 }],
      },
      md(),
    );

    expect(res.operatorId).toBe('from-group');
    expect(candidatesFor).toHaveBeenCalled();
  });

  it('an UNREACHABLE source propagates — it must not be reported as an empty desk', async () => {
    // The failure nobody notices: routing stops for a whole team while every request answers 200.
    const { prisma } = fakePrisma();
    const { controller } = build(prisma, new Error('auth unavailable'));
    await expect(
      controller.autoAssignConversation({ conversationId: 'c1', groupId: 'g-1' }, md()),
    ).rejects.toThrow(/auth unavailable/);
  });

  it('a conversation from another account is not found before any pool work happens', async () => {
    const { prisma, conversation } = fakePrisma();
    conversation.findFirst.mockResolvedValue(null);
    const { controller, candidatesFor } = build(prisma, [cand('op-a')]);

    await expect(
      controller.autoAssignConversation({ conversationId: 'c1', groupId: 'g-1' }, md('acc-42')),
    ).rejects.toThrow();
    // No existence disclosure, and no cross-service traffic on behalf of a caller who may not ask.
    expect(candidatesFor).not.toHaveBeenCalled();
  });

  it('the caller-supplied path never writes a routed group', async () => {
    // A later manual re-route must not erase which desk originally took the work, so the column is
    // left untouched rather than nulled.
    const { prisma, conversation } = fakePrisma();
    const { controller } = build(prisma, []);
    await controller.autoAssignConversation(
      { conversationId: 'c1', groupKey: 'legacy', candidates: [{ operatorId: 'op-x', capacity: 5, currentLoad: 0 }] },
      md(),
    );
    const data = conversation.updateMany.mock.calls[0]?.[0]?.data ?? {};
    expect(Object.keys(data)).not.toContain('routed_group_id');
  });
});

/**
 * T014 (feature 031, FR-004) — **the router names ITSELF, and this is a regression assertion.**
 *
 * ⭐ Already satisfied before this feature: `round-robin-state.repository.ts` records the transition with
 * `systemActor('auto-assign')`, and its comment states the reasoning — *"the actor is the router itself,
 * because 'the system' is not an answer"*. Pinned here rather than rebuilt, because a routing decision that
 * cannot be told apart from a person's decision makes the whole stream unreadable for the one question
 * analytics asks of it: how much work does routing actually move?
 *
 * ⚠️ **There is deliberately NO audit ENTRY**, and that is a finding rather than an omission. Conversation
 * assignment is not an audited action anywhere in this product — the catalogue has `role.assign`,
 * `player.assign` and `player.unassign`, and no `conversation.assign`. Auto-assignment is therefore not
 * *less* recorded than a person's assignment; both live in the transition stream. Adding an audit action
 * only for the automatic path would make the trail assert that the router is more sensitive than a human
 * doing the same thing, which is backwards.
 *
 * ⇒ FR-004's "one audit entry" is out of scope for this feature and belongs with whatever point decides
 * that conversation assignment is an audited act — for EITHER actor.
 */
/**
 * T014 (feature 031, FR-004) — **a regression assertion, not new behaviour.**
 *
 * ⭐ Already satisfied before this feature: the router records the transition with
 * `systemActor('auto-assign')`, and its own comment gives the reasoning — *"the actor is the router itself,
 * because 'the system' is not an answer"*. Pinned here because a routing decision that cannot be told apart
 * from a person's makes the stream unreadable for the one question analytics asks of it.
 *
 * ⚠️ **There is deliberately NO audit ENTRY, and that is a finding rather than an omission.** Conversation
 * assignment is not an audited action anywhere in this product: the catalogue has `role.assign`,
 * `player.assign` and `player.unassign`, and no `conversation.assign`. So auto-assignment is not *less*
 * recorded than a person's assignment — both live in the transition stream. Adding an audit action only for
 * the automatic path would make the trail assert that the router is more sensitive than a human doing the
 * same thing, which is backwards.
 *
 * ⇒ FR-004's "one audit entry" is **out of scope here** and belongs with whatever point decides that
 * conversation assignment is an audited act — for EITHER actor.
 */
describe('T014 — the routing decision names the router as the actor', () => {
  it('⭐ records exactly one transition, with a SYSTEM actor', async () => {
    const { prisma, conversationTransition } = fakePrisma();
    const { controller } = build(prisma, [cand('op-a')]);

    const res = await controller.autoAssignConversation(
      { conversationId: 'c1', groupId: 'g-1' },
      md(),
    );
    expect(res.assigned).toBe(true);

    expect(conversationTransition.create).toHaveBeenCalledTimes(1);
    const row = conversationTransition.create.mock.calls[0]![0]!.data as Record<string, unknown>;
    expect(row.actor_kind).toBe('system');
    // ⚠️ And it names WHICH system — "the system" is not an answer when three of them can assign.
    expect(String(row.actor_ref)).toContain('auto-assign');
  });
});

/**
 * T018/T021 on the router's own path (feature 031, roadmap 4.20).
 *
 * The unit tests for the queue live in `backlog.spec.ts`; these two assert the wiring — that work which
 * does not fit **enters** the queue, and that work which gets an owner **leaves** it.
 */
describe('the router and the backlog', () => {
  const withBacklog = (candidates: RoundRobinCandidate[]) => {
    const prismaFake = fakePrisma();
    const backlog = {
      enqueue: jest.fn(async (a: string, b: string, c: Date, d?: string) => {
        void a; void b; void c; void d;
      }),
      dequeue: jest.fn(async () => undefined),
      waiting: jest.fn(async () => []),
    };
    const controller = new AutoAssignController(
      new RoundRobinStateRepository(
        prismaFake.prisma,
        new TransitionRecorder(),
        fakeStatusRepository(),
      ),
      new ConversationRepository(prismaFake.prisma, new TransitionRecorder()),
      { candidatesFor: jest.fn(async () => ({ candidates, reason: null })) } as unknown as GroupPoolService,
      backlog as unknown as BacklogRepository,
    );
    return { controller, backlog };
  };

  it('⭐ work that fits NOWHERE enters the queue instead of staying unowned', async () => {
    // Before this feature the answer was NO_OPERATOR_AVAILABLE and the conversation "stayed as it was" —
    // nothing recorded that it was waiting, in what order, or that it should be retried.
    const { controller, backlog } = withBacklog([cand('op-a', 4, 4)]);

    const res = await controller.autoAssignConversation({ conversationId: 'c1', groupId: 'g-1' }, md());

    expect(res.assigned).toBe(false);
    expect(backlog.enqueue).toHaveBeenCalledTimes(1);
    expect(backlog.dequeue).not.toHaveBeenCalled();
  });

  it('⭐ POSITIVE CONTROL: work that FITS is assigned and leaves the queue', async () => {
    // Without this, the assertion above is satisfied by a router that queues everything.
    const { controller, backlog } = withBacklog([cand('op-a', 4, 0)]);

    const res = await controller.autoAssignConversation({ conversationId: 'c1', groupId: 'g-1' }, md());

    expect(res.assigned).toBe(true);
    expect(backlog.dequeue).toHaveBeenCalledTimes(1);
    expect(backlog.enqueue).not.toHaveBeenCalled();
  });

  it('⭐ a NAMED DESK with nobody available also queues — the everyday case', async () => {
    // Found live. "Everyone is full" is rarer than "nobody is at this desk at this minute" — a shift gap,
    // a lunch hour, a night — and that half was answered without queueing anything: the work sat unowned
    // with no record and no retry, which is the failure the queue exists to prevent.
    const { controller, backlog } = withBacklog([]);

    const res = await controller.autoAssignConversation({ conversationId: 'c1', groupId: 'g-1' }, md());

    expect(res.assigned).toBe(false);
    expect(backlog.enqueue).toHaveBeenCalledTimes(1);
    // …and the DESK travels with it, or the drain has nothing to retry against.
    expect(backlog.enqueue.mock.calls[0]![3]).toBe('g-1');
  });

  it('⛔ but a caller-supplied candidate list with nobody in it does NOT queue', async () => {
    // There is no desk to retry against, so queueing would produce work the drain can only ever report as
    // `no_desk`. The honest answer is the refusal the caller already handles.
    const { controller, backlog } = withBacklog([]);
    await controller.autoAssignConversation({ conversationId: 'c1', candidates: [] }, md());
    expect(backlog.enqueue).not.toHaveBeenCalled();
  });
});
