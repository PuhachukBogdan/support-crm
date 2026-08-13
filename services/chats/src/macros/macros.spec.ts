import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { ConversationRepository } from '../conversation/conversation.repository';
import { LabelsRepository } from '../labels/labels.repository';
import { MacrosRepository } from './macros.repository';
import { MacrosController } from './macros.grpc.controller';
import {
  MACRO_ACTION_TYPES,
  parseActions as parseActionsWith,
  requiredPermissions,
} from './macro-definition';
import { TransitionRecorder } from '../transition/transition.recorder';
import { StatusRepository } from '../status/status.repository';

/**
 * ⭐ Feature 032 (roadmap 4.16): a `SET_STATUS` value is validated against the ACCOUNT's configured
 * statuses. The pure cases below bind that catalogue once — see `rule-definition.spec.ts` for the same
 * pattern and for why `closed` is deliberately not in it.
 */
const KEYS = ['new', 'open', 'pending', 'vip_pending', 'in_progress', 'solved'] as const;
const parseActions = (input: unknown) => parseActionsWith(input, KEYS);

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
    { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'pending' },
    { type: 'MACRO_ACTION_TYPE_ADD_LABEL', value: 'l1' },
  ],
};
const DEF_WITH_ASSIGN = {
  actions: [
    { type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'pending' },
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
  // Feature 023: `create` RETURNS a statement here rather than performing a write — that is what
  // makes the transition land in the same batch as the action it describes.
  const conversationTransition = {
    create: jest.fn((a: unknown) => ({ __stmt: 'transition.create', arg: a })),
  };
  const conversationLabel = {
    upsert: over.linkUpsert ?? jest.fn().mockReturnValue({ __stmt: 'link.upsert' }),
    deleteMany: jest.fn(),
    findMany: jest.fn(),
  };
  // Feature 032: the account's status catalogue, read through the real `StatusRepository`.
  const conversationStatus = {
    findMany: over.statusFindMany ?? jest.fn().mockResolvedValue(KEYS.map((key) => ({ key }))),
    findFirst: over.statusFindFirst ?? jest.fn().mockResolvedValue({ key: 'pending', active: true }),
  };
  // ⭐ W29: the usage fact — `create` returns a statement (it rides the apply batch), groupBy is
  // the weekly counter's one read.
  const macroApplication = {
    create: over.usageCreate ?? jest.fn().mockReturnValue({ __stmt: 'usage.create' }),
    groupBy: over.usageGroupBy ?? jest.fn().mockResolvedValue([]),
  };
  const $transaction = over.$transaction ?? jest.fn().mockResolvedValue([]);
  const forAccount = jest
    .fn()
    .mockReturnValue({
      conversation,
      macro,
      label,
      conversationLabel,
      conversationTransition,
      conversationStatus,
      macroApplication,
      $transaction,
    });
  return {
    prisma: { forAccount } as unknown as PrismaService,
    conversationTransition,
    conversation,
    macro,
    label,
    conversationLabel,
    $transaction,
    forAccount,
  };
}

function md(perms: string[], accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u1');
  m.set('x-actor-permissions', perms.join(','));
  return m;
}

/** W29: availability degrades to «unscoped only» when auth is silent — this stub IS that outage. */
const noAuthority = {
  listUserGroups: async () => null,
} as unknown as import('../auth/auth.client').AuthorAuthorityClient;

const fakeAudit = () => {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    repo: {
      statement: (_a: string, input: Record<string, unknown>) => {
        entries.push(input);
        return Promise.resolve({});
      },
    } as unknown as import('../audit/audit.repository').AuditRepository,
  };
};

const build = (prisma: PrismaService, audit = fakeAudit().repo, authority = noAuthority) =>
  new MacrosController(
    new MacrosRepository(prisma, new TransitionRecorder(), new StatusRepository(prisma)),
    new LabelsRepository(prisma),
    new ConversationRepository(prisma, new TransitionRecorder()),
    new StatusRepository(prisma),
    authority,
    audit,
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
      ? 'open'
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
      // Feature 032: `closed` is a real CATEGORY with no seeded status, so the key does not exist here.
      parseActions([{ type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'closed' }]),
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
    // Feature 023 made it three (status + label + the transition recording the change); W29 makes
    // it FOUR — the usage fact rides the same batch, so the weekly counter counts only macros that
    // actually landed. All-or-nothing covers the record of the act exactly as it covers the act.
    expect(batch).toHaveLength(4);
    const transition = (batch as Array<Record<string, unknown>>).find(
      (b) => b.__stmt === 'transition.create',
    );
    expect(transition).toBeDefined();
    expect(
      (batch as Array<Record<string, unknown>>).find((b) => b.__stmt === 'usage.create'),
    ).toBeDefined();
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

describe('W8 — the list gate is the USE key, structurally', () => {
  // Unit calls above bypass the guard (direct method invocation), so the DECORATOR VALUE is the
  // fact to pin: LISTING rides `crm.macros.use` (the picker is for agents — no agent role holds
  // `templates.manage`, which is why the W7 window's macro button had nothing to offer), while
  // AUTHORING stays lead-level. The guard's deny-by-default behaviour has its own spec.
  const required = (method: object) =>
    Reflect.getMetadata('rbac:chats_required_permission', method);

  it('ListMacros requires crm.macros.use; DefineMacro stays crm.templates.manage', () => {
    expect(required(MacrosController.prototype.listMacros)).toBe('crm.macros.use');
    expect(required(MacrosController.prototype.defineMacro)).toBe('crm.templates.manage');
  });
});

/**
 * ⭐⭐ W29 (R46) — the authoring upgrades, and the LATENT DEFECT the block surfaced.
 */
describe('W29 — apply: the priority case that never existed, and the U9 classification lock', () => {
  it('⭐ SET_PRIORITY applies — word AND rank in one statement (the 014 gap, pinned)', async () => {
    // Before W29 this action validated at define, passed the permission check at apply, and then
    // mapped to `undefined` in the batch: the whole apply died. The automation applier had the
    // case; the macro applier did not. This test fails on the old code.
    const { prisma, conversation } = fakePrisma({
      macroFindFirst: jest.fn().mockResolvedValue({
        id: 'm1',
        name: 'urgent',
        definition: { actions: [{ type: 'MACRO_ACTION_TYPE_SET_PRIORITY', value: 'high' }] },
      }),
    });
    await build(prisma).applyMacro({ conversationId: 'c1', macroId: 'm1' }, md(ALL_PERMS));
    expect(conversation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ priority: 'high', priority_rank: expect.any(Number) }),
      }),
    );
  });

  it('⭐ SET_CATEGORY lands WITH classified_by = the OPERATOR — U9: a macro is a human act', async () => {
    const { prisma, conversation } = fakePrisma({
      macroFindFirst: jest.fn().mockResolvedValue({
        id: 'm1',
        name: 'classify',
        definition: {
          actions: [
            { type: 'MACRO_ACTION_TYPE_SET_CATEGORY', value: 'payments' },
            { type: 'MACRO_ACTION_TYPE_SET_SUB_CATEGORY', value: 'deposit' },
          ],
        },
      }),
    });
    await build(prisma).applyMacro({ conversationId: 'c1', macroId: 'm1' }, md(ALL_PERMS));
    expect(conversation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { category: 'payments', classified_by: 'u1' } }),
    );
    expect(conversation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sub_category: 'deposit', classified_by: 'u1' } }),
    );
  });
});

describe('W29 — availability («кому доступен») and the weekly counter on the list read', () => {
  const THREE = [
    { id: 'm1', name: 'for-everyone', definition: { actions: DEF_STATUS_LABEL.actions } },
    { id: 'm2', name: 'vip-only', definition: { actions: DEF_STATUS_LABEL.actions, groupIds: ['g-vip'] } },
    { id: 'm3', name: 'other-desk', definition: { actions: DEF_STATUS_LABEL.actions, groupIds: ['g-x'] } },
  ];

  it('an AGENT sees unscoped macros plus their groups’; an AUTHOR sees everything', async () => {
    const { prisma } = fakePrisma({ macroFindMany: jest.fn().mockResolvedValue(THREE) });
    const membership = {
      listUserGroups: jest.fn(async () => ['g-vip']),
    } as unknown as import('../auth/auth.client').AuthorAuthorityClient;

    const asAgent = await build(prisma, fakeAudit().repo, membership).listMacros(
      {},
      md(['crm.macros.use']),
    );
    expect(asAgent.macros.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2']);

    const asAuthor = await build(prisma, fakeAudit().repo, membership).listMacros(
      {},
      md(['crm.macros.use', 'crm.templates.manage']),
    );
    expect(asAuthor.macros.map((m: { id: string }) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('⚠️ a silent auth degrades to UNSCOPED ONLY — the narrow direction, never a raise', async () => {
    const { prisma } = fakePrisma({ macroFindMany: jest.fn().mockResolvedValue(THREE) });
    const res = await build(prisma).listMacros({}, md(['crm.macros.use'])); // noAuthority → null
    expect(res.macros.map((m: { id: string }) => m.id)).toEqual(['m1']);
  });

  it('the weekly counter rides the list from ONE grouped read', async () => {
    const { prisma } = fakePrisma({
      macroFindMany: jest.fn().mockResolvedValue([THREE[0]]),
      usageGroupBy: jest.fn().mockResolvedValue([{ macro_id: 'm1', _count: { macro_id: 4 } }]),
    });
    const res = await build(prisma, fakeAudit().repo, noAuthority).listMacros(
      {},
      md(['crm.macros.use', 'crm.templates.manage']),
    );
    expect(res.macros[0]).toMatchObject({ id: 'm1', appliedLast7: 4 });
  });
});

describe('W29 — define carries text + scope; delete is audited with the NAME', () => {
  it('define stores the extras and answers them back', async () => {
    const { prisma } = fakePrisma();
    const res = await build(prisma).defineMacro(
      {
        name: 'refund',
        actions: [{ type: 'MACRO_ACTION_TYPE_SET_STATUS', value: 'pending' }],
        text: 'Ваш возврат оформлен.',
        groupIds: ['g-vip', 'g-vip', ''],
      },
      md(ALL_PERMS),
    );
    expect(res).toMatchObject({ text: 'Ваш возврат оформлен.', groupIds: ['g-vip'] });
  });

  it('⭐ delete: the audit entry rides the SAME transaction and keeps the name the row loses', async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = jest.fn(async (batch: unknown[]) => {
      expect(batch).toHaveLength(2); // the delete AND its record — together or not at all
      return [{ count: 1 }];
    });
    const { prisma } = fakePrisma({ $transaction: tx });
    (prisma.forAccount('acc-1') as unknown as { macro: Record<string, unknown> }).macro.deleteMany =
      deleteMany;
    const audit = fakeAudit();
    const res = await build(prisma, audit.repo).deleteMacro({ macroId: 'm1' }, md(ALL_PERMS));
    expect(res).toEqual({ ok: true });
    expect(audit.entries[0]).toMatchObject({ action: 'macro.delete', detail: { name: 'triage' } });
  });

  it('deleting a macro another account owns is NOT_FOUND — same words as an absent one', async () => {
    const { prisma } = fakePrisma({ macroFindFirst: jest.fn().mockResolvedValue(null) });
    await expect(
      build(prisma).deleteMacro({ macroId: 'm-foreign' }, md(ALL_PERMS)),
    ).rejects.toMatchObject({ error: { code: GrpcStatus.NOT_FOUND } });
  });
});
