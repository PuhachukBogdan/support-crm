import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { ConversationRepository } from '../conversation/conversation.repository';
import { LabelsRepository } from '../labels/labels.repository';
import { MacrosRepository } from './macros.repository';
import { MacrosController } from './macros.grpc.controller';
import { MACRO_ACTION_TYPES, parseActions, requiredPermissions } from './macro-definition';

/**
 * T021 (feature 013, US2) — macros. The load-bearing assertion is **all-or-nothing** (FR-008 /
 * SC-004): a macro containing an action the caller may not perform is refused with **zero** writes,
 * not a rolled-back partial attempt. Unknown action types are rejected at define AND apply.
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
  created_at: new Date('2026-07-26T10:00:00.000Z'),
  updated_at: new Date('2026-07-26T10:00:00.000Z'),
  ...over,
});

const DEF_STATUS_LABEL = {
  actions: [
    { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'CONVERSATION_STATUS_PENDING' },
    { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' },
  ],
};
const DEF_WITH_ASSIGN = {
  actions: [
    { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'CONVERSATION_STATUS_PENDING' },
    { type: 'MACRO_ACTION_TYPE_ASSIGN', value: 'op-a' },
  ],
};

function fakePrisma(over: Record<string, jest.Mock> = {}) {
  const conversation = {
    findFirst: over.convFindFirst ?? jest.fn().mockResolvedValue(conversationRow()),
    updateMany: over.convUpdateMany ?? jest.fn().mockReturnValue({ __stmt: 'conv.update' }),
    findMany: jest.fn(),
    create: jest.fn(),
  };
  const macro = {
    findFirst: over.macroFindFirst ?? jest.fn().mockResolvedValue({
      id: 'm1',
      name: 'triage',
      definition: DEF_STATUS_LABEL,
    }),
    findMany: over.macroFindMany ?? jest.fn().mockResolvedValue([]),
    create: over.macroCreate ?? jest.fn().mockResolvedValue({ id: 'm9', name: 'new' }),
  };
  const label = {
    findFirst: over.labelFindFirst ?? jest.fn().mockResolvedValue({ id: 'l1' }),
    findMany: jest.fn(),
    create: jest.fn(),
  };
  const conversationLabel = {
    upsert: over.linkUpsert ?? jest.fn().mockReturnValue({ __stmt: 'link.upsert' }),
    deleteMany: jest.fn(),
    findMany: jest.fn(),
  };
  const $transaction = over.$transaction ?? jest.fn().mockResolvedValue([]);
  const forAccount = jest
    .fn()
    .mockReturnValue({ conversation, macro, label, conversationLabel, $transaction });
  return {
    prisma: { forAccount } as unknown as PrismaService,
    conversation,
    macro,
    label,
    conversationLabel,
    $transaction,
    forAccount,
  };
}

function md(perms: string[], accountId = 'acc-1', brands: string[] = ['brand-a']): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
  m.set('x-actor-brands', brands.join(','));
  m.set('x-actor-permissions', perms.join(','));
  return m;
}

const build = (prisma: PrismaService) =>
  new MacrosController(
    new MacrosRepository(prisma),
    new LabelsRepository(prisma),
    new ConversationRepository(prisma),
  );

const ALL_PERMS = [
  'crm.macros.use',
  'crm.templates.manage',
  'crm.conversation.reply',
  'crm.labels.manage',
  'crm.conversation.assign',
];

describe('macro definition (pure validation, R4)', () => {
  /** A value each action type accepts — the two typed ones validate against their allow-list. */
  const okValue = (type: string) =>
    type === 'MACRO_ACTION_TYPE_SET_STATUS'
      ? 'CONVERSATION_STATUS_OPEN'
      : type === 'MACRO_ACTION_TYPE_SET_PRIORITY'
        ? 'high'
        : 'x';

  it('accepts every action type in the shared vocabulary', () => {
    for (const type of MACRO_ACTION_TYPES) {
      const value = okValue(type);
      expect(parseActions([{ type, value }])).toEqual([{ type, value }]);
    }
  });

  // Feature 014 — the vocabulary is now shared with automation rules, and SET_PRIORITY is the first
  // action whose value is validated against a closed priority list (see shared/wire.ts).
  it('validates a SET_PRIORITY value against the priority allow-list', () => {
    expect(parseActions([{ type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'low' }])).toEqual([
      { type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'low' },
    ]);
    for (const bad of ['URGENT', 'urgent', 'critical', 'HIGH', '*']) {
      expect(() =>
        parseActions([{ type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: bad }]),
      ).toThrow();
    }
  });

  it('needs crm.conversation.reply for SET_PRIORITY (same class of act as SET_STATUS, R9)', () => {
    expect(
      requiredPermissions(parseActions([{ type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'high' }])),
    ).toEqual(['crm.conversation.reply']);
  });

  it.each([
    'MACRO_ACTION_TYPE_SEND_MESSAGE',
    'SET_STATUS',
    'assign',
    '',
    undefined,
  ])('rejects the unknown action type %p', (type) => {
    expect(() => parseActions([{ type, value: 'x' }])).toThrow();
  });

  it('rejects an empty action list, a blank value and a bogus status', () => {
    expect(() => parseActions([])).toThrow();
    expect(() => parseActions([{ type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: '  ' }])).toThrow();
    expect(() =>
      parseActions([{ type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'CONVERSATION_STATUS_CLOSED' }]),
    ).toThrow();
  });

  it('maps each action to the permission it needs on its own (no bundling loophole)', () => {
    expect(requiredPermissions(parseActions(DEF_WITH_ASSIGN.actions))).toEqual([
      'crm.conversation.reply',
      'crm.conversation.assign',
    ]);
  });
});

describe('DefineMacro', () => {
  it('stores a validated definition under the account', async () => {
    const { prisma, macro } = fakePrisma();
    const res = await build(prisma).defineMacro(
      { name: ' triage ', actions: [{ type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' }] },
      md(ALL_PERMS),
    );
    expect(macro.create.mock.calls[0][0]).toMatchObject({
      data: {
        account_id: 'acc-1',
        name: 'triage',
        definition: { actions: [{ type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' }] },
      },
    });
    expect(res).toMatchObject({ id: 'm9', name: 'new' });
  });

  it('refuses an unknown action type at DEFINE time — nothing is stored', async () => {
    const { prisma, macro } = fakePrisma();
    await expect(
      build(prisma).defineMacro(
        { name: 'bad', actions: [{ type: 'MACRO_ACTION_TYPE_SEND_MESSAGE', value: 'hi' }] },
        md(ALL_PERMS),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(macro.create).not.toHaveBeenCalled();
  });

  it('refuses a macro with no actions', async () => {
    const { prisma, macro } = fakePrisma();
    await expect(
      build(prisma).defineMacro({ name: 'empty', actions: [] }, md(ALL_PERMS)),
    ).rejects.toBeInstanceOf(RpcException);
    expect(macro.create).not.toHaveBeenCalled();
  });
});

describe('ApplyMacro — all-or-nothing (FR-008 / SC-004)', () => {
  it('applies every action in ONE transaction', async () => {
    const { prisma, $transaction, conversation, conversationLabel } = fakePrisma();
    await build(prisma).applyMacro({ conversationId: 'c1', macroId: 'm1' }, md(ALL_PERMS));

    expect($transaction).toHaveBeenCalledTimes(1);
    const batch = $transaction.mock.calls[0][0] as unknown[];
    expect(batch).toHaveLength(2); // set status + add label
    expect(conversation.updateMany).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { status: 'pending' }, // wire name → storage scalar
    });
    expect(conversationLabel.upsert).toHaveBeenCalled();
  });

  it('*** refuses the whole macro when ANY action is not permitted — ZERO writes ***', async () => {
    const { prisma, $transaction, conversation, conversationLabel } = fakePrisma({
      macroFindFirst: jest
        .fn()
        .mockResolvedValue({ id: 'm2', name: 'triage+assign', definition: DEF_WITH_ASSIGN }),
    });
    // Caller may apply macros and set status, but NOT assign.
    const perms = ['crm.macros.use', 'crm.conversation.reply', 'crm.labels.manage'];

    await expect(
      build(prisma).applyMacro({ conversationId: 'c1', macroId: 'm2' }, md(perms)),
    ).rejects.toBeInstanceOf(RpcException);

    expect($transaction).not.toHaveBeenCalled();
    expect(conversation.updateMany).not.toHaveBeenCalled();
    expect(conversationLabel.upsert).not.toHaveBeenCalled();
  });

  it('checks permissions BEFORE touching the conversation (refusal precedes any read of it)', async () => {
    const order: string[] = [];
    const { prisma } = fakePrisma({
      convFindFirst: jest.fn(() => {
        order.push('conversation');
        return Promise.resolve(conversationRow());
      }),
      macroFindFirst: jest.fn(() => {
        order.push('macro');
        return Promise.resolve({ id: 'm2', name: 'x', definition: DEF_WITH_ASSIGN });
      }),
    });
    await expect(
      build(prisma).applyMacro(
        { conversationId: 'c1', macroId: 'm2' },
        md(['crm.macros.use', 'crm.conversation.reply']),
      ),
    ).rejects.toBeInstanceOf(RpcException);
    expect(order).toEqual(['macro']); // the conversation was never even read
  });

  it('is NOT_FOUND when the macro belongs to another account', async () => {
    const { prisma, $transaction } = fakePrisma({
      macroFindFirst: jest.fn().mockResolvedValue(null),
    });
    await expect(
      build(prisma).applyMacro({ conversationId: 'c1', macroId: 'foreign' }, md(ALL_PERMS)),
    ).rejects.toBeInstanceOf(RpcException);
    expect($transaction).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ A test asserting NOT_FOUND "for a conversation in a brand the caller may not serve" stood here
   * and was REMOVED by feature 020's cleanup (ADR 0038 §1), along with the guard it covered.
   *
   * It passed for four phases while the production path could not reach that branch: `mayAccessBrand`
   * compared against a caller brand set that nothing ever populated, so it could only return true.
   * The test supplied the set by hand, and therefore proved the helper's arithmetic and nothing about
   * the product.
   *
   * There is ONE support department. A brand never decides who may see what — it is part of a
   * player's IDENTITY (feature 020) and a filter a caller may ask for.
   */

  it('refuses when an ADD_LABEL action references a label outside the account (pre-validated)', async () => {
    const { prisma, $transaction } = fakePrisma({
      labelFindFirst: jest.fn().mockResolvedValue(null),
    });
    await expect(
      build(prisma).applyMacro({ conversationId: 'c1', macroId: 'm1' }, md(ALL_PERMS)),
    ).rejects.toBeInstanceOf(RpcException);
    expect($transaction).not.toHaveBeenCalled(); // never opened → nothing to roll back
  });

  it('refuses a stored definition this version cannot apply (no partial best-effort)', async () => {
    const { prisma, $transaction } = fakePrisma({
      macroFindFirst: jest.fn().mockResolvedValue({
        id: 'm3',
        name: 'legacy',
        definition: { actions: [{ type: 'MACRO_ACTION_TYPE_SEND_MESSAGE', value: 'hi' }] },
      }),
    });
    await expect(
      build(prisma).applyMacro({ conversationId: 'c1', macroId: 'm3' }, md(ALL_PERMS)),
    ).rejects.toBeInstanceOf(RpcException);
    expect($transaction).not.toHaveBeenCalled();
  });

  it('requires both ids', async () => {
    const { prisma } = fakePrisma();
    await expect(
      build(prisma).applyMacro({ conversationId: '', macroId: 'm1' }, md(ALL_PERMS)),
    ).rejects.toBeInstanceOf(RpcException);
    await expect(
      build(prisma).applyMacro({ conversationId: 'c1', macroId: '' }, md(ALL_PERMS)),
    ).rejects.toBeInstanceOf(RpcException);
  });
});

describe('ListMacros', () => {
  it('is account-scoped and re-validates stored definitions', async () => {
    const { prisma, forAccount } = fakePrisma({
      macroFindMany: jest.fn().mockResolvedValue([
        { id: 'm1', name: 'ok', definition: DEF_STATUS_LABEL },
        { id: 'm2', name: 'legacy', definition: { actions: [{ type: 'NOPE', value: 'x' }] } },
      ]),
    });
    const res = await build(prisma).listMacros({}, md(ALL_PERMS, 'acc-3'));
    expect(forAccount).toHaveBeenCalledWith('acc-3');
    expect(res.macros[0]!.actions).toHaveLength(2);
    expect(res.macros[1]!.actions).toEqual([]); // unreadable blob surfaces as empty, never as junk
  });
});
