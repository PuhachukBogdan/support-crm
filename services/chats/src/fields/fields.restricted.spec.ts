import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { PrismaService } from '../prisma.service';
import { fakeRealtime } from '../realtime/realtime.fake';
import { FieldsRepository } from './fields.repository';
import { FieldsController } from './fields.grpc.controller';

/**
 * ⭐ Feature 037 (roadmap 4.15 — W30, US3) — «поле, скрытое ролью, ОТСУТСТВУЕТ, а не пусто».
 *
 * The whole claim in three parts (FR-016):
 *  1. positive control FIRST: a cleared caller sees the definition AND the value;
 *  2. an uncleared caller's payload contains NEITHER — absent, not blanked, not disabled;
 *  3. a direct write by the restricted key gets the SAME refusal an unknown key gets, byte for
 *     byte — a write must not be usable as an existence oracle.
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
      return {
        findFirst: async (args?: { where?: Row }) => {
          const hit = all().find((r) => matchesWhere(r, args?.where));
          return hit ? { ...hit } : null;
        },
        findMany: async (args?: { where?: Row }) =>
          all()
            .filter((r) => matchesWhere(r, args?.where))
            .map((r) => ({ ...r })),
        updateMany: (args: { where: Row; data: Row }) => {
          const hits = all().filter((r) => matchesWhere(r, args.where));
          for (const r of hits) Object.assign(r, args.data);
          return { count: hits.length };
        },
        deleteMany: (args: { where: Row }) => {
          const doomed = all().filter((r) => matchesWhere(r, args.where));
          for (const d of doomed) tables[name]!.splice(tables[name]!.indexOf(d), 1);
          return { count: doomed.length };
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
          else tables[name]!.push({ id: `${name}-${++seq}`, account_id: acc, ...args.create });
          return {};
        },
      };
    };
    const scoped: Row = {};
    for (const name of Object.keys(tables)) scoped[name] = model(name);
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

function seedPayments(w: World) {
  const acc = 'acc-1';
  w.tables.fieldDefinition!.push(
    {
      id: 'fd-psp',
      account_id: acc,
      key: 'payment_provider',
      label: 'Payment provider',
      type: 'text',
      required: false,
      restricted: true, // ← the flag under test
      option_set_id: null,
      brand_ids: [],
      active: true,
    },
    {
      id: 'fd-note',
      account_id: acc,
      key: 'contact_note',
      label: 'Contact note',
      type: 'text',
      required: false,
      restricted: false,
      option_set_id: null,
      brand_ids: [],
      active: true,
    },
  );
  w.tables.form!.push({
    id: 'form-pay',
    account_id: acc,
    key: 'payments',
    name: 'Payments',
    category: 'Payments',
    active: true,
    order: 10,
  });
  w.tables.formField!.push(
    { account_id: acc, form_id: 'form-pay', field_id: 'fd-psp', order: 0, condition_field_id: null, condition_value: null, is_subcategory_source: false },
    { account_id: acc, form_id: 'form-pay', field_id: 'fd-note', order: 1, condition_field_id: null, condition_value: null, is_subcategory_source: false },
  );
  w.tables.conversation!.push({
    id: 'c-1',
    account_id: acc,
    brand_id: 'brand-a',
    form_key: 'payments',
    category: 'Payments',
    sub_category: null,
    classified_by: null,
    shelved_state: null,
  });
  w.tables.conversationFieldValue!.push(
    { id: 'cfv-psp', account_id: acc, conversation_id: 'c-1', field_id: 'fd-psp', value: 'held-provider-value' },
    { id: 'cfv-note', account_id: acc, conversation_id: 'c-1', field_id: 'fd-note', value: 'plain note' },
  );
}

/** Clearance is the CALLER's, carried per call in the permissions header. */
function md(cleared: boolean): Metadata {
  const perms = ['crm.inbox.view', 'crm.conversation.reply'];
  if (cleared) perms.push('crm.conversation.restricted_field.view');
  const m = new Metadata();
  m.set('x-actor-account-id', 'acc-1');
  m.set('x-actor-user-id', 'op-1');
  m.set('x-actor-permissions', perms.join(','));
  return m;
}

const build = (w: World) => new FieldsController(new FieldsRepository(w.prisma), fakeRealtime().publisher);

async function refusalOf(p: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RpcException);
    return (e as RpcException).getError() as { code: number; message: string };
  }
  throw new Error('expected a refusal, got a success');
}

describe('US3 — a restricted field is withheld server-side, per caller', () => {
  it('⭐ POSITIVE CONTROL FIRST: the cleared caller sees definition AND value, and may write it', async () => {
    const w = makeWorld();
    seedPayments(w);
    const ctrl = build(w);

    const view = await ctrl.getConversationFieldView({ conversationId: 'c-1' }, md(true));
    expect(view.entries.map((e: { field: { key: string } }) => e.field.key)).toEqual([
      'payment_provider',
      'contact_note',
    ]);
    expect(view.values).toContainEqual({ fieldKey: 'payment_provider', value: 'held-provider-value' });

    await ctrl.setConversationFieldValue(
      { conversationId: 'c-1', fieldKey: 'payment_provider', value: 'new-provider' },
      md(true),
    );
    expect(w.tables.conversationFieldValue!.find((v) => v.field_id === 'fd-psp')!.value).toBe('new-provider');
  });

  it('⭐ the uncleared payload contains NEITHER the definition NOR the value — absent, not blanked', async () => {
    const w = makeWorld();
    seedPayments(w);
    const view = await build(w).getConversationFieldView({ conversationId: 'c-1' }, md(false));

    expect(view.entries.map((e: { field: { key: string } }) => e.field.key)).toEqual(['contact_note']);
    expect(view.values).toEqual([{ fieldKey: 'contact_note', value: 'plain note' }]);

    // The strongest form of "absent": neither the key nor the held value appears ANYWHERE in the
    // payload — a blanked or disabled rendition would fail this.
    const wire = JSON.stringify(view);
    expect(wire).not.toContain('payment_provider');
    expect(wire).not.toContain('held-provider-value');
  });

  it('*** a write by the restricted key gets THE SAME refusal an unknown key gets — no oracle ***', async () => {
    const w = makeWorld();
    seedPayments(w);
    const ctrl = build(w);

    const restricted = await refusalOf(
      ctrl.setConversationFieldValue(
        { conversationId: 'c-1', fieldKey: 'payment_provider', value: 'probe' },
        md(false),
      ),
    );
    const unknown = await refusalOf(
      ctrl.setConversationFieldValue({ conversationId: 'c-1', fieldKey: 'ghost_key', value: 'probe' }, md(false)),
    );

    // Literal equality of code AND message: any divergence is an existence oracle.
    expect(restricted).toEqual(unknown);
    expect(restricted).toEqual({ code: GrpcStatus.NOT_FOUND, message: 'unknown field' });

    // And the probe changed nothing.
    expect(w.tables.conversationFieldValue!.find((v) => v.field_id === 'fd-psp')!.value).toBe(
      'held-provider-value',
    );
  });
});
