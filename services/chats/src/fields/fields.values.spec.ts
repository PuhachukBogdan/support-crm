import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { fakeRealtime } from '../realtime/realtime.fake';
import { FieldsRepository } from './fields.repository';
import { FieldsController } from './fields.grpc.controller';

/**
 * ⭐ Feature 037 (roadmap 4.15 — W30, US2) — the agent's writes on the ticket window, behind the
 * real controller + repository over an in-memory Prisma.
 *
 * The load-bearing claims:
 *  • the refusal MATRIX is fail-closed and worded, and nothing invalid is ever stored (FR-009);
 *  • the identical value is an idempotent no-op that publishes NO second event (FR-010);
 *  • a parent change clears every dependent whose condition no longer holds, in ONE transaction,
 *    recursively (FR-008 — the L1→L2→L3 cascade);
 *  • the sub-category source routes to the RESERVED column with the actor recorded, and never
 *    becomes a stored field value (FR-012);
 *  • a form choice with a category files the conversation (human lock); a category-less form
 *    leaves category untouched (FR-007);
 *  • the view offers ACTIVE options plus the held deactivated value — and nothing else.
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

function sortRows(rows: Row[], orderBy?: unknown): Row[] {
  const specs = orderBy == null ? [] : Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs as Array<Record<string, 'asc' | 'desc'>>) {
      const entry = Object.entries(spec)[0];
      if (!entry) continue;
      const [field, dir] = entry;
      const av = (a[field] ?? '') as never;
      const bv = (b[field] ?? '') as never;
      if (av === bv) continue;
      const cmp = av < bv ? -1 : 1;
      return dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

function makeWorld() {
  let seq = 0;
  const tables: Record<string, Row[]> = {
    optionSet: [],
    optionValue: [],
    fieldDefinition: [],
    form: [],
    formField: [],
    conversationFieldValue: [],
    conversation: [],
  };
  const batches: unknown[][] = [];

  const ACCOUNT_SCOPED = new Set([
    'optionSet',
    'fieldDefinition',
    'form',
    'conversation',
    'conversationFieldValue',
    // W30 review: children carry account_id themselves — the fake must not be more permissive.
    'optionValue',
    'formField',
  ]);

  function scopedFor(acc: string): Row {
    const model = (name: string) => {
      const all = () =>
        ACCOUNT_SCOPED.has(name)
          ? tables[name]!.filter((r) => r.account_id === acc)
          : tables[name]!;
      const insert = (data: Row): Row => {
        const row: Row = { id: `${name}-${++seq}`, ...data };
        if (ACCOUNT_SCOPED.has(name)) row.account_id = acc;
        tables[name]!.push(row);
        return row;
      };
      return {
        findFirst: async (args?: { where?: Row; orderBy?: unknown }) => {
          const hit = sortRows(all(), args?.orderBy).find((r) => matchesWhere(r, args?.where));
          return hit ? { ...hit } : null;
        },
        findMany: async (args?: { where?: Row; orderBy?: unknown }) =>
          sortRows(all(), args?.orderBy)
            .filter((r) => matchesWhere(r, args?.where))
            .map((r) => ({ ...r })),
        create: (args: { data: Row }) => {
          insert(args.data);
          return { __stmt: `${name}.create` };
        },
        updateMany: (args: { where: Row; data: Row }) => {
          const hits = all().filter((r) => matchesWhere(r, args.where));
          for (const r of hits) Object.assign(r, args.data);
          return { count: hits.length, __stmt: `${name}.updateMany` };
        },
        deleteMany: (args: { where: Row }) => {
          const doomed = all().filter((r) => matchesWhere(r, args.where));
          for (const d of doomed) tables[name]!.splice(tables[name]!.indexOf(d), 1);
          return { count: doomed.length, __stmt: `${name}.deleteMany` };
        },
        upsert: (args: { where: Row; create: Row; update: Row }) => {
          const key = args.where.conversation_id_field_id as {
            conversation_id: string;
            field_id: string;
          };
          const hit = all().find(
            (r) => r.conversation_id === key.conversation_id && r.field_id === key.field_id,
          );
          if (hit) Object.assign(hit, args.update);
          else insert(args.create);
          return { __stmt: `${name}.upsert` };
        },
      };
    };
    const scoped: Row = {};
    for (const name of Object.keys(tables)) scoped[name] = model(name);
    scoped.$transaction = (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(scoped);
      batches.push(arg as unknown[]);
      return Promise.resolve((arg as unknown[]).map((s) => s ?? {}));
    };
    return scoped;
  }

  const prisma = { forAccount: jest.fn((acc: string) => scopedFor(acc)) } as unknown as PrismaService;
  return { prisma, tables, batches };
}
type World = ReturnType<typeof makeWorld>;

/**
 * The Deposits shape from the capture (frame 032): an L1 sub-category source, an L2 unlocked by
 * L1 = «Deposit status», an L3 unlocked by L2 = «Declined», a required numeric, plus one field off
 * the form and one limited to another brand. Keys are fixture-chosen (specs are exempt from the
 * no-field-key-branch scan; product code stays clean).
 */
function seedDeposits(w: World) {
  const acc = 'acc-1';
  const t = w.tables;
  t.optionSet!.push(
    { id: 'os-l1', account_id: acc, name: 'Topics' },
    { id: 'os-l2', account_id: acc, name: 'Deposit statuses' },
    { id: 'os-l3', account_id: acc, name: 'Declined reasons' },
  );
  t.optionValue!.push(
    { account_id: acc, id: 'ov-1', option_set_id: 'os-l1', value: 'Deposit status', order: 0, active: true },
    { account_id: acc, id: 'ov-2', option_set_id: 'os-l1', value: 'Payments', order: 1, active: true },
    { account_id: acc, id: 'ov-3', option_set_id: 'os-l1', value: 'Retired topic', order: 2, active: false },
    { account_id: acc, id: 'ov-4', option_set_id: 'os-l2', value: 'Declined', order: 0, active: true },
    { account_id: acc, id: 'ov-5', option_set_id: 'os-l2', value: 'Pending', order: 1, active: true },
    { account_id: acc, id: 'ov-6', option_set_id: 'os-l2', value: 'Legacy', order: 2, active: false },
    { account_id: acc, id: 'ov-7', option_set_id: 'os-l3', value: 'Timeout', order: 0, active: true },
    { account_id: acc, id: 'ov-8', option_set_id: 'os-l3', value: 'Old reason', order: 1, active: false },
  );
  const field = (id: string, key: string, over: Row = {}): Row => {
    const row: Row = {
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
    };
    t.fieldDefinition!.push(row);
    return row;
  };
  field('fd-l1', 'deposit_topic', { type: 'dropdown', option_set_id: 'os-l1' });
  field('fd-l2', 'deposit_state', { type: 'dropdown', option_set_id: 'os-l2' });
  field('fd-l3', 'declined_reason', { type: 'dropdown', option_set_id: 'os-l3' });
  field('fd-amount', 'amount', { type: 'numeric', required: true });
  field('fd-orphan', 'orphan_note'); // exists, NOT on the form
  field('fd-country', 'country_limited', { brand_ids: ['brand-b'] }); // on the form, other brand
  t.form!.push(
    { id: 'form-dep', account_id: acc, key: 'deposits', name: 'Deposits', category: 'Deposits', active: true, order: 10 },
    { id: 'form-plain', account_id: acc, key: 'plain', name: 'Default', category: null, active: true, order: 20 },
  );
  t.formField!.push(
    { account_id: acc, form_id: 'form-dep', field_id: 'fd-l1', order: 0, condition_field_id: null, condition_value: null, is_subcategory_source: true },
    { account_id: acc, form_id: 'form-dep', field_id: 'fd-l2', order: 1, condition_field_id: 'fd-l1', condition_value: 'Deposit status', is_subcategory_source: false },
    { account_id: acc, form_id: 'form-dep', field_id: 'fd-l3', order: 2, condition_field_id: 'fd-l2', condition_value: 'Declined', is_subcategory_source: false },
    { account_id: acc, form_id: 'form-dep', field_id: 'fd-amount', order: 3, condition_field_id: null, condition_value: null, is_subcategory_source: false },
    { account_id: acc, form_id: 'form-dep', field_id: 'fd-country', order: 4, condition_field_id: null, condition_value: null, is_subcategory_source: false },
  );
  t.conversation!.push({
    id: 'c-1',
    account_id: acc,
    brand_id: 'brand-a',
    form_key: 'deposits',
    category: null,
    sub_category: null,
    classified_by: null,
    shelved_state: null,
  });
  return { convo: () => t.conversation!.find((c) => c.id === 'c-1')! };
}

function md(accountId = 'acc-1', userId = 'op-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', userId);
  m.set('x-actor-permissions', ['crm.inbox.view', 'crm.conversation.reply'].join(','));
  return m;
}

function build(w: World) {
  const realtime = fakeRealtime();
  const ctrl = new FieldsController(new FieldsRepository(w.prisma), realtime.publisher);
  return { ctrl, published: realtime.published };
}

async function refusalOf(p: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RpcException);
    return (e as RpcException).getError() as { code: number; message: string };
  }
  throw new Error('expected a refusal, got a success');
}

const write = (
  ctrl: FieldsController,
  fieldKey: string,
  value: string,
  clear = false,
  metadata = md(),
) => ctrl.setConversationFieldValue({ conversationId: 'c-1', fieldKey, value, clear }, metadata);

describe('*** the refusal matrix — fail-closed, worded, nothing stored (FR-009) ***', () => {
  it.each([
    ['unknown field key', 'ghost_key', '5', GrpcStatus.NOT_FOUND, 'unknown field'],
    ['field not on the form', 'orphan_note', 'x', GrpcStatus.FAILED_PRECONDITION, "the field is not on this conversation's form"],
    ['brand-inapplicable field', 'country_limited', 'x', GrpcStatus.FAILED_PRECONDITION, "the field does not apply to this conversation's brand"],
    ['condition not met', 'deposit_state', 'Declined', GrpcStatus.FAILED_PRECONDITION, 'the field is hidden by its parent choice'],
    ['non-number in numeric', 'amount', 'ten', GrpcStatus.INVALID_ARGUMENT, 'the value must be a number'],
    ['value outside the set', 'deposit_topic', 'Nonsense', GrpcStatus.INVALID_ARGUMENT, "the value is not in the field's option set"],
    ['deactivated value', 'deposit_topic', 'Retired topic', GrpcStatus.INVALID_ARGUMENT, "the value is not in the field's option set"],
  ])('%s → worded refusal, state unchanged', async (_name, key, value, code, message) => {
    const w = makeWorld();
    const { convo } = seedDeposits(w);
    const { ctrl, published } = build(w);

    expect(await refusalOf(write(ctrl, key, value))).toEqual({ code, message });

    expect(w.tables.conversationFieldValue!).toHaveLength(0);
    expect(convo()).toMatchObject({ category: null, sub_category: null, classified_by: null });
    expect(w.batches).toHaveLength(0);
    expect(published).toHaveLength(0);
  });
});

describe('idempotence and the explicit clear (FR-010)', () => {
  it('⭐ the identical value twice: one row, one transaction, ONE realtime event', async () => {
    const w = makeWorld();
    seedDeposits(w);
    const { ctrl, published } = build(w);

    await write(ctrl, 'amount', '100');
    expect(w.tables.conversationFieldValue!).toHaveLength(1);
    expect(published).toHaveLength(1);

    const res = await write(ctrl, 'amount', '100'); // the second identical click
    expect(res).toEqual({ ok: true }); // succeeds…
    expect(w.tables.conversationFieldValue!).toHaveLength(1); // …changes nothing…
    expect(w.batches).toHaveLength(1); // …opens no second transaction…
    expect(published).toHaveLength(1); // …and fans out no second event.
  });

  it('clear is explicit, allowed even on a REQUIRED field (required gates solve, not editing)', async () => {
    const w = makeWorld();
    seedDeposits(w);
    const { ctrl, published } = build(w);

    await write(ctrl, 'amount', '100');
    await write(ctrl, 'amount', '', true);
    expect(w.tables.conversationFieldValue!).toHaveLength(0);
    expect(published).toHaveLength(2); // the clear IS a change

    // Clearing what is already empty is the idempotent no-op again.
    await write(ctrl, 'amount', '', true);
    expect(published).toHaveLength(2);
  });

  it('an empty value WITHOUT clear is refused — emptiness must be said, not implied', async () => {
    const w = makeWorld();
    seedDeposits(w);
    const { ctrl } = build(w);
    const e = await refusalOf(write(ctrl, 'amount', '   '));
    expect(e).toEqual({ code: GrpcStatus.INVALID_ARGUMENT, message: 'a value is required (use clear to empty)' });
  });
});

describe('⭐ the sub-category source and the cascade (FR-008 / FR-012)', () => {
  it('the source value lands in the RESERVED column with the actor — and stores NO field-value row', async () => {
    const w = makeWorld();
    const { convo } = seedDeposits(w);
    const { ctrl } = build(w);

    await write(ctrl, 'deposit_topic', 'Deposit status');

    expect(convo()).toMatchObject({ sub_category: 'Deposit status', classified_by: 'op-1' });
    expect(w.tables.conversationFieldValue!).toHaveLength(0); // never duplicated as a value row
  });

  it('⭐ changing L1 clears L2 AND L3 in the SAME transaction — no orphaned hidden values', async () => {
    const w = makeWorld();
    const { convo } = seedDeposits(w);
    const { ctrl } = build(w);

    await write(ctrl, 'deposit_topic', 'Deposit status'); // unlocks L2
    await write(ctrl, 'deposit_state', 'Declined'); // unlocks L3
    await write(ctrl, 'declined_reason', 'Timeout');
    expect(w.tables.conversationFieldValue!).toHaveLength(2); // L2 + L3

    const batchesBefore = w.batches.length;
    await write(ctrl, 'deposit_topic', 'Payments'); // L2's condition no longer holds

    expect(w.batches).toHaveLength(batchesBefore + 1); // ONE transaction for the whole act
    expect(w.batches[w.batches.length - 1]).toHaveLength(3); // sub-category write + two clears
    expect(convo()).toMatchObject({ sub_category: 'Payments' });
    expect(w.tables.conversationFieldValue!).toHaveLength(0); // L2 and L3 both gone
  });
});

describe('the form choice (FR-007)', () => {
  it('⭐ a category-bearing form files the conversation with the actor; a category-less one touches nothing', async () => {
    const w = makeWorld();
    seedDeposits(w);
    w.tables.conversation!.push({
      id: 'c-2',
      account_id: 'acc-1',
      brand_id: 'brand-a',
      form_key: null,
      category: null,
      sub_category: null,
      classified_by: null,
      shelved_state: null,
    });
    const { ctrl, published } = build(w);
    const c2 = () => w.tables.conversation!.find((c) => c.id === 'c-2')!;

    await ctrl.setConversationForm({ conversationId: 'c-2', formKey: 'plain' }, md());
    expect(c2()).toMatchObject({ form_key: 'plain', category: null, classified_by: null });

    await ctrl.setConversationForm({ conversationId: 'c-2', formKey: 'deposits' }, md());
    expect(c2()).toMatchObject({ form_key: 'deposits', category: 'Deposits', classified_by: 'op-1' });
    expect(published).toHaveLength(2);

    // Same form again: idempotent no-op, no third event.
    await ctrl.setConversationForm({ conversationId: 'c-2', formKey: 'deposits' }, md());
    expect(published).toHaveLength(2);
  });

  it('an unknown or inactive form is NOT_FOUND, and the row is untouched', async () => {
    const w = makeWorld();
    const { convo } = seedDeposits(w);
    const { ctrl } = build(w);
    const e = await refusalOf(ctrl.setConversationForm({ conversationId: 'c-1', formKey: 'ghost' }, md()));
    expect(e).toEqual({ code: GrpcStatus.NOT_FOUND, message: 'form not found' });
    expect(convo()).toMatchObject({ form_key: 'deposits' });
  });
});

describe('GetConversationFieldView — active options plus the HELD deactivated value', () => {
  it('a stored deactivated value stays offered on ITS field only; category echo reads the reserved columns', async () => {
    const w = makeWorld();
    const { convo } = seedDeposits(w);
    Object.assign(convo(), { category: 'Deposits', sub_category: 'Deposit status', classified_by: 'op-1' });
    // L2 holds a value its set has since deactivated — the historical read must survive.
    w.tables.conversationFieldValue!.push({
      id: 'cfv-legacy',
      account_id: 'acc-1',
      conversation_id: 'c-1',
      field_id: 'fd-l2',
      value: 'Legacy',
    });
    const { ctrl } = build(w);

    const view = await ctrl.getConversationFieldView({ conversationId: 'c-1' }, md());

    const entryOf = (key: string) =>
      view.entries.find((e: { field: { key: string } }) => e.field.key === key)!;

    // L2: active values + the held 'Legacy', marked inactive.
    expect(entryOf('deposit_state').options).toEqual([
      { value: 'Declined', order: 0, active: true },
      { value: 'Pending', order: 1, active: true },
      { value: 'Legacy', order: 2, active: false },
    ]);
    // L3 holds nothing → deactivated options are NOT offered.
    expect(entryOf('declined_reason').options).toEqual([{ value: 'Timeout', order: 0, active: true }]);
    // The source's held value is the reserved column, not a value row.
    expect(view.values).toEqual([{ fieldKey: 'deposit_state', value: 'Legacy' }]);
    expect(view).toMatchObject({
      formKey: 'deposits',
      category: 'Deposits',
      subCategory: 'Deposit status',
      classifiedBy: 'op-1',
    });
    // The brand-inapplicable entry is absent from the render.
    expect(view.entries.some((e: { field: { key: string } }) => e.field.key === 'country_limited')).toBe(false);
    expect(view.availableForms.map((f: { key: string }) => f.key)).toEqual(['deposits', 'plain']);
  });

  it('a formless conversation renders as unfiled — no entries, no gate, forms still offered', async () => {
    const w = makeWorld();
    seedDeposits(w);
    w.tables.conversation!.push({
      id: 'c-3',
      account_id: 'acc-1',
      brand_id: 'brand-a',
      form_key: null,
      category: null,
      sub_category: null,
      classified_by: null,
      shelved_state: null,
    });
    const { ctrl } = build(w);
    const view = await ctrl.getConversationFieldView({ conversationId: 'c-3' }, md());
    expect(view.entries).toEqual([]);
    expect(view.values).toEqual([]);
    expect(view.availableForms.length).toBeGreaterThan(0);
  });

  it("another account's conversation is NOT FOUND — indistinguishable from absent", async () => {
    const w = makeWorld();
    seedDeposits(w);
    const { ctrl } = build(w);
    const e = await refusalOf(ctrl.getConversationFieldView({ conversationId: 'c-1' }, md('acc-2')));
    expect(e.code).toBe(GrpcStatus.NOT_FOUND);
  });
});
