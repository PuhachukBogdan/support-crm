import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Reflector } from '@nestjs/core';
import type { PrismaService } from '../prisma.service';
import { ChatsAccessGuard } from '../security/permission.guard';
import { REQUIRED_CHATS_PERMISSION_KEY } from '../security/requires-chats-permission.decorator';
import { InitiateConversationController } from './initiate.grpc.controller';

/**
 * ⭐ W17 (subpoint 4.6) — write first. **THE BLOCK'S INVARIANT: the portfolio rule holds on the
 * WRITE, server-side** — an AM whose role narrows to their own portfolio may initiate only to a
 * player attached to them, checked with feature 030's own predicate against the same source the
 * reads use. A hidden button proves nothing about a crafted request.
 *
 * The rest of the behaviour: everything that can refuse runs BEFORE the first write (no known
 * address · no email channel · no open status — each its own class), and the create carries the
 * participant handle so the reply path's outbox machinery is inherited, not restated.
 */

const md = (opts: { role?: string; perms?: string[] } = {}): Metadata => {
  const m = new Metadata();
  m.set('x-actor-account-id', 'acc-1');
  m.set('x-actor-user-id', 'u-am');
  m.set(
    'x-actor-permissions',
    (opts.perms ?? ['crm.inbox.view', 'crm.conversation.reply', 'crm.vip.workspace']).join(','),
  );
  if (opts.role) m.set('x-actor-effective-role', opts.role);
  return m;
};

function harness(opts: {
  portfolio?: Array<{ brandId: string; playerId: string }>;
  participant?: string | null;
  channel?: boolean;
  statusKey?: string | null;
} = {}) {
  const created: Array<Record<string, unknown>> = [];
  const posted: Array<Record<string, unknown>> = [];

  const conversations = {
    create: async (accountId: string, input: Record<string, unknown>) => {
      created.push({ accountId, ...input });
      return { id: 'conv-new', account_id: accountId, brand_id: input.brandId, status: input.status };
    },
    getById: async () => ({
      id: 'conv-new',
      brand_id: 'brand-a',
      player_id: 'p1',
      status: 'open',
      status_def: { category: 'open' },
      priority: 'normal',
      assignee_operator_id: 'op-am',
      channel: 'email',
      reference: null,
      category: null,
      sub_category: null,
      classified_by: null,
      subject: 'Hello',
      subject_source: 'manual',
      routed_group_id: null,
      created_at: new Date('2026-08-07T10:00:00.000Z'),
      updated_at: new Date('2026-08-07T10:00:00.000Z'),
    }),
  };
  const messages = {
    post: async (accountId: string, input: Record<string, unknown>) => {
      posted.push({ accountId, ...input });
      return { id: 'msg-new' };
    },
  };
  const statuses = {
    defaultKeyOfCategory: async () => (opts.statusKey === undefined ? 'open' : opts.statusKey),
  };
  const person = {
    attachedPlayersOfCaller: async () => opts.portfolio ?? [{ brandId: 'brand-a', playerId: 'p1' }],
  };
  const participants = {
    playerEmailParticipant: async () => (opts.participant === undefined ? 'part-1' : opts.participant),
  };
  const operators = { resolveCallerOperatorId: async () => 'op-am' };
  const events = { conversationCreated: jest.fn(async () => 0) };
  const realtime = { conversation: jest.fn(async () => 0) };
  const prisma = {
    forAccount: () => ({
      channel: {
        findFirst: async () => (opts.channel === false ? null : { id: 'ch-email' }),
      },
    }),
  } as unknown as PrismaService;

  const controller = new InitiateConversationController(
    conversations as never,
    messages as never,
    statuses as never,
    person as never,
    participants as never,
    operators as never,
    events as never,
    realtime as never,
    prisma,
  );
  return { controller, created, posted, events, realtime };
}

const REQ = { brandId: 'brand-a', playerId: 'p1', subject: 'Hello', body: 'A word first.' };

describe('*** the portfolio rule holds on the WRITE (server-side) ***', () => {
  it('⭐ an AM may NOT initiate to a player outside their portfolio — 030’s predicate, on the write', async () => {
    const { controller, created, posted } = harness({ portfolio: [{ brandId: 'brand-a', playerId: 'other' }] });
    await expect(
      controller.initiateEmailConversation(REQ, md({ role: 'am' })),
    ).rejects.toThrow(RpcException);
    expect(created).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it('⭐ POSITIVE CONTROL: the same AM initiates to their OWN player', async () => {
    const { controller, created, posted } = harness({ portfolio: [{ brandId: 'brand-a', playerId: 'p1' }] });
    const res = await controller.initiateEmailConversation(REQ, md({ role: 'am' }));
    expect(created).toHaveLength(1);
    expect(posted).toHaveLength(1);
    expect(res.id).toBe('conv-new');
  });

  it('⚠️ the PAIR is what is checked — the same player id under another brand is another human', async () => {
    const { controller, created } = harness({ portfolio: [{ brandId: 'brand-B', playerId: 'p1' }] });
    await expect(
      controller.initiateEmailConversation(REQ, md({ role: 'am' })),
    ).rejects.toThrow(RpcException);
    expect(created).toHaveLength(0);
  });

  it('an administrator is not narrowed — exactly as on reads (masked_pii is the clearance)', async () => {
    // No effective role header at all = not narrowed (the gateway sets it only when one resolves).
    const { controller, created } = harness({ portfolio: [] });
    await controller.initiateEmailConversation(REQ, md({}));
    expect(created).toHaveLength(1);
  });
});

describe('everything that can refuse runs BEFORE the first write', () => {
  it.each([
    ['no known address', { participant: null }],
    ['no email channel for the brand', { channel: false }],
    ['no open status configured', { statusKey: null }],
  ])('%s → refused, nothing created, nothing posted', async (_name, opts) => {
    const { controller, created, posted } = harness(opts as never);
    await expect(controller.initiateEmailConversation(REQ, md({}))).rejects.toThrow(RpcException);
    expect(created).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it('an empty body is not a message', async () => {
    const { controller, created } = harness();
    await expect(
      controller.initiateEmailConversation({ ...REQ, body: '   ' }, md({})),
    ).rejects.toThrow(RpcException);
    expect(created).toHaveLength(0);
  });
});

describe('what the create carries', () => {
  it('⭐ the participant handle, the email channel, the manual subject and the initiator as assignee', async () => {
    const { controller, created, posted } = harness();
    await controller.initiateEmailConversation(REQ, md({}));
    expect(created[0]).toMatchObject({
      brandId: 'brand-a',
      playerId: 'p1',
      channel: 'email',
      status: 'open',
      identityState: 'identified',
      channelParticipantId: 'part-1',
      assigneeOperatorId: 'op-am',
      subject: 'Hello',
      subjectSource: 'manual',
    });
    // The first message rides the SAME post path a reply takes — the outbox intent is inherited.
    expect(posted[0]).toMatchObject({
      conversationId: 'conv-new',
      authorType: 'operator',
      isPrivate: false,
      body: 'A word first.',
    });
  });

  it('no subject means NO title and NO source — the derivation window stays honest', async () => {
    const { controller, created } = harness();
    await controller.initiateEmailConversation({ ...REQ, subject: '' }, md({}));
    expect(created[0]).not.toHaveProperty('subject');
    expect(created[0]).not.toHaveProperty('subjectSource');
  });
});

describe('the gate is the MODULE key, and that is the point', () => {
  it('⛔ declares crm.vip.workspace — the reply key alone (every agent’s) is refused', () => {
    // Gating on `crm.conversation.reply` would let a LINE AGENT — whom the portfolio rule never
    // narrows, because they have no portfolio — write first to ANY customer: initiation as an
    // anti-pitching bypass. The module key makes writing first the act of exactly the people
    // whose act it is (am/shift_am + administrators).
    expect(
      new Reflector().get<string>(
        REQUIRED_CHATS_PERMISSION_KEY,
        InitiateConversationController.prototype.initiateEmailConversation,
      ),
    ).toBe('crm.vip.workspace');

    const guard = new ChatsAccessGuard(new Reflector());
    const asPerms = (perms: string[]) =>
      ({
        getType: () => 'rpc',
        getHandler: () => InitiateConversationController.prototype.initiateEmailConversation,
        getClass: () => InitiateConversationController,
        switchToRpc: () => ({ getContext: () => md({ perms }) }),
      }) as never;
    // A line agent's shape: reply yes, module no.
    expect(() => guard.canActivate(asPerms(['crm.inbox.view', 'crm.conversation.reply']))).toThrow(
      RpcException,
    );
    // The positive control: the module key admits.
    expect(guard.canActivate(asPerms(['crm.conversation.reply', 'crm.vip.workspace']))).toBe(true);
  });
});
