import { Metadata } from '@grpc/grpc-js';
import type { PrismaService } from '../prisma.service';
import { ConversationRepository } from '../conversation/conversation.repository';
import { RoundRobinStateRepository } from './round-robin-state.repository';
import { TransitionRecorder } from '../transition/transition.recorder';
import type { GroupPoolService } from './group-pool';
import type { RoundRobinCandidate } from './round-robin';
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
    findMany: jest.fn(),
    create: jest.fn(),
  };
  const roundRobinState = {
    findFirst: jest.fn().mockResolvedValue(null),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    create: jest.fn().mockResolvedValue({ id: 'rr1' }),
  };
  const conversationTransition = { create: jest.fn() };
  const scoped = { conversation, roundRobinState, conversationTransition } as Record<string, unknown>;
  scoped.$transaction = jest.fn(function (this: unknown, cb: (tx: unknown) => unknown) {
    if (this !== scoped) throw new TypeError('$transaction lost its binding');
    return cb(scoped);
  });
  const forAccount = jest.fn().mockReturnValue(scoped);
  return {
    prisma: { forAccount } as unknown as PrismaService,
    conversation,
    roundRobinState,
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
    new RoundRobinStateRepository(prisma, new TransitionRecorder()),
    new ConversationRepository(prisma, new TransitionRecorder()),
    { candidatesFor } as unknown as GroupPoolService,
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
    expect(candidatesFor).toHaveBeenCalledWith('acc-1', 'grp-payments', expect.anything(), null);
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
