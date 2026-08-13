import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import type { DomainEventPublisher } from '../events/events.publisher';
import { ConversationRepository } from './conversation.repository';
import { ConversationWriteController } from './conversation.write.controller';
import { TransitionRecorder } from '../transition/transition.recorder';
import { fakeStatusRepository } from '../status/status.fixture';
import { fakeRealtime } from '../realtime/realtime.fake';
import { noInboxUnseen, noOperatorIdentity } from '../shared/operator-identity.fake';
import { FieldsRepository } from '../fields/fields.repository';

/**
 * ⭐ Feature 037 (roadmap 4.15 — W30, FR-011) — the solve gate, through the REAL status write and
 * the REAL fields repository (not a stubbed gate: the wiring is half the claim).
 *
 * Required means required-to-SOLVE: a transition into a TERMINAL category is refused, naming the
 * empty required field keys, while everything the actor cannot currently see — condition not
 * held, brand not applicable, restricted from this caller — does NOT gate (an invisible
 * requirement would be an unfixable refusal). No form ⇒ no gate.
 */

type Row = Record<string, unknown>;

function matchesWhere(row: Row, where?: Row): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === 'OR') {
      if (!(v as Row[]).some((w) => matchesWhere(row, w))) return false;
      continue;
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      const op = v as Row;
      if ('in' in op) {
        if (!(op.in as unknown[]).includes(row[k])) return false;
        continue;
      }
      if ('not' in op) {
        if (row[k] === op.not) return false;
        continue;
      }
      throw new Error(`fake prisma: unsupported operator on ${k}`);
    }
    if (row[k] !== v) return false;
  }
  return true;
}

function makeWorld() {
  const tables: Record<string, Row[]> = {
    fieldDefinition: [],
    form: [],
    formField: [],
    conversationFieldValue: [],
    conversation: [],
  };
  const ACCOUNT_SCOPED = new Set(['fieldDefinition', 'form', 'conversation', 'conversationFieldValue']);

  function scopedFor(acc: string): Row {
    const model = (name: string) => {
      const all = () =>
        ACCOUNT_SCOPED.has(name)
          ? tables[name]!.filter((r) => r.account_id === acc)
          : tables[name]!;
      return {
        findFirst: async (args?: { where?: Row }) => {
          const hit = all().find((r) => matchesWhere(r, args?.where));
          return hit ? { ...hit } : null;
        },
        findMany: async (args?: { where?: Row }) =>
          all()
            .filter((r) => matchesWhere(r, args?.where))
            .map((r) => ({ ...r })),
        updateMany: async (args: { where: Row; data: Row }) => {
          const hits = all().filter((r) => matchesWhere(r, args.where));
          for (const r of hits) Object.assign(r, args.data, { updated_at: new Date() });
          return { count: hits.length };
        },
      };
    };
    const scoped: Row = {};
    for (const name of Object.keys(tables)) scoped[name] = model(name);
    scoped.conversationTransition = {
      create: async (a: { data: Row }) => a.data,
    };
    scoped.$transaction = (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => unknown)(scoped)
        : Promise.resolve((arg as unknown[]).map((s) => s ?? {}));
    return scoped;
  }
  const prisma = { forAccount: jest.fn((acc: string) => scopedFor(acc)) } as unknown as PrismaService;
  return { prisma, tables };
}
type World = ReturnType<typeof makeWorld>;

function seedGateWorld(w: World) {
  const acc = 'acc-1';
  const field = (id: string, key: string, over: Row = {}) =>
    w.tables.fieldDefinition!.push({
      id,
      account_id: acc,
      key,
      label: key,
      type: 'text',
      required: false,
      restricted: false,
      option_set_id: null,
      brand_ids: [],
      active: true,
      ...over,
    });
  // The four requirement shapes, one field each:
  field('fd-amount', 'amount', { type: 'numeric', required: true }); // visible ⇒ gates
  field('fd-psp', 'payment_provider', { required: true, restricted: true }); // gates only the cleared
  field('fd-l2', 'hidden_by_condition', { required: true }); // condition never holds here
  field('fd-country', 'other_brand_only', { required: true, brand_ids: ['brand-b'] });
  field('fd-l1', 'topic'); // the (optional) condition parent — dropdown-ness is irrelevant to the gate read
  w.tables.form!.push({
    id: 'form-dep',
    account_id: acc,
    key: 'deposits',
    name: 'Deposits',
    category: 'Deposits',
    active: true,
    order: 10,
  });
  w.tables.formField!.push(
    { form_id: 'form-dep', field_id: 'fd-l1', order: 0, condition_field_id: null, condition_value: null, is_subcategory_source: false },
    { form_id: 'form-dep', field_id: 'fd-amount', order: 1, condition_field_id: null, condition_value: null, is_subcategory_source: false },
    { form_id: 'form-dep', field_id: 'fd-psp', order: 2, condition_field_id: null, condition_value: null, is_subcategory_source: false },
    { form_id: 'form-dep', field_id: 'fd-l2', order: 3, condition_field_id: 'fd-l1', condition_value: 'never-chosen', is_subcategory_source: false },
    { form_id: 'form-dep', field_id: 'fd-country', order: 4, condition_field_id: null, condition_value: null, is_subcategory_source: false },
  );
  w.tables.conversation!.push(conversationRow('c-1', { form_key: 'deposits' }));
  w.tables.conversation!.push(conversationRow('c-formless', { form_key: null }));
}

function conversationRow(id: string, over: Row): Row {
  return {
    id,
    account_id: 'acc-1',
    brand_id: 'brand-a',
    player_id: 'p-1',
    status: 'open',
    priority: null,
    priority_rank: 0,
    assignee_operator_id: null,
    channel: 'chat',
    created_at: new Date('2026-08-12T10:00:00.000Z'),
    updated_at: new Date('2026-08-12T10:00:00.000Z'),
    reference: null,
    category: null,
    sub_category: null,
    classified_by: null,
    subject: 'не приходит вывод',
    subject_source: 'source',
    shelved_state: null,
    identity_state: 'identified',
    routed_group_id: null,
    continues_conversation_id: null,
    form_key: null,
    ...over,
  };
}

function md(cleared = false): Metadata {
  const perms = ['crm.inbox.view', 'crm.conversation.reply'];
  if (cleared) perms.push('crm.conversation.restricted_field.view');
  const m = new Metadata();
  m.set('x-actor-account-id', 'acc-1');
  m.set('x-actor-user-id', 'op-1');
  m.set('x-actor-effective-role', 'agent');
  m.set('x-actor-permissions', perms.join(','));
  return m;
}

function build(w: World) {
  const realtime = fakeRealtime();
  const events = {
    conversationCreated: jest.fn(),
    statusChanged: jest.fn(),
  } as unknown as DomainEventPublisher;
  const ctrl = new ConversationWriteController(
    new ConversationRepository(w.prisma, new TransitionRecorder()),
    events,
    // 'solved' resolves to the TERMINAL category; 'open' to a non-terminal one.
    fakeStatusRepository(['open', 'solved']),
    {} as never,
    realtime.publisher,
    noInboxUnseen(),
    noOperatorIdentity(),
    new FieldsRepository(w.prisma), // the REAL gate, not a stub
  );
  return { ctrl, events, published: realtime.published };
}

const fillAmount = (w: World) =>
  w.tables.conversationFieldValue!.push({
    id: 'cfv-amount',
    account_id: 'acc-1',
    conversation_id: 'c-1',
    field_id: 'fd-amount',
    value: '100',
  });

const statusOf = (w: World, id: string) =>
  w.tables.conversation!.find((c) => c.id === id)!.status;

describe('⭐ FR-011 — the terminal transition is gated by empty required VISIBLE fields', () => {
  it('refused with FAILED_PRECONDITION naming ONLY the visible key — hidden/brand/restricted do not gate', async () => {
    const w = makeWorld();
    seedGateWorld(w);
    const { ctrl } = build(w);

    let error: { code: number; message: string } | undefined;
    try {
      await ctrl.setConversationStatus({ conversationId: 'c-1', statusKey: 'solved' }, md());
    } catch (e) {
      expect(e).toBeInstanceOf(RpcException);
      error = (e as RpcException).getError() as { code: number; message: string };
    }
    // Exactly one field gates: `amount`. The restricted one is withheld from this actor, the
    // conditional one is hidden, the brand-limited one does not apply — naming any of them would
    // be an unfixable refusal.
    expect(error).toEqual({
      code: GrpcStatus.FAILED_PRECONDITION,
      message: 'required fields are empty: amount',
    });
    expect(statusOf(w, 'c-1')).toBe('open'); // nothing moved
  });

  it('⭐ filling the named field makes the SAME transition succeed', async () => {
    const w = makeWorld();
    seedGateWorld(w);
    fillAmount(w);
    const { ctrl, events, published } = build(w);

    const res = await ctrl.setConversationStatus({ conversationId: 'c-1', statusKey: 'solved' }, md());

    expect(res.statusKey).toBe('solved');
    expect(statusOf(w, 'c-1')).toBe('solved');
    expect((events.statusChanged as unknown as jest.Mock).mock.calls).toHaveLength(1);
    expect(published).toContainEqual(
      expect.objectContaining({ kind: 'conversation.updated', conversationId: 'c-1' }),
    );
  });

  it('for the CLEARED actor the restricted required field DOES gate — visibility is per caller', async () => {
    const w = makeWorld();
    seedGateWorld(w);
    fillAmount(w); // amount satisfied; payment_provider still empty
    const { ctrl } = build(w);

    await expect(
      ctrl.setConversationStatus({ conversationId: 'c-1', statusKey: 'solved' }, md(true)),
    ).rejects.toMatchObject({
      error: {
        code: GrpcStatus.FAILED_PRECONDITION,
        message: 'required fields are empty: payment_provider',
      },
    });
    expect(statusOf(w, 'c-1')).toBe('open');
  });

  it('a conversation with NO form is not gated at all', async () => {
    const w = makeWorld();
    seedGateWorld(w);
    const { ctrl } = build(w);
    const res = await ctrl.setConversationStatus(
      { conversationId: 'c-formless', statusKey: 'solved' },
      md(),
    );
    expect(res.statusKey).toBe('solved');
    expect(statusOf(w, 'c-formless')).toBe('solved');
  });

  it('a NON-terminal transition is never gated — required means required-to-solve, not to save', async () => {
    const w = makeWorld();
    seedGateWorld(w);
    const { ctrl } = build(w);
    // `amount` is empty, but `open` is not a terminal category.
    const res = await ctrl.setConversationStatus({ conversationId: 'c-1', statusKey: 'open' }, md());
    expect(res.statusKey).toBe('open');
  });
});
