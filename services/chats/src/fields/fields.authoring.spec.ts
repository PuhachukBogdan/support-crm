import { Metadata, status as GrpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { Reflector } from '@nestjs/core';
import type { PrismaService } from '../prisma.service';
import { AuditRepository } from '../audit/audit.repository';
import { ChatsAccessGuard } from '../security/permission.guard';
import { REQUIRED_CHATS_PERMISSION_KEY } from '../security/requires-chats-permission.decorator';
import { FieldsRepository } from './fields.repository';
import { FieldsAdminController } from './fields-admin.grpc.controller';

/**
 * ⭐ Feature 037 (roadmap 4.15 — W30, US1) — the authoring surface, behind the real controller and
 * the real repository over an in-memory Prisma.
 *
 * What is pinned here, in the status-admin discipline:
 *  • the KEY is derived from the label/name, never caller-chosen;
 *  • every structural refusal is worded and writes NOTHING (no committed audit, no batch);
 *  • every successful write commits its audit statement IN the same batch, with the right action
 *    and target_ref;
 *  • archive-over-delete: a referenced set is undeletable, a used value only deactivates;
 *  • cross-account: account B's sets/fields/forms are structurally unreachable from account A
 *    (this file carries the 037 isolation assertions — see the isolation describe below).
 */

type Row = Record<string, unknown>;

// ── a tiny where-matcher: equality, {in}, {not}, OR — exactly what the repository issues ─────────
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

interface World {
  prisma: PrismaService;
  forAccount: jest.Mock;
  tables: Record<string, Row[]>;
  /** Audit entries that actually COMMITTED (rode an executed $transaction) — not merely built. */
  committedAudits: Row[];
  batches: unknown[][];
  writes: Array<{ table: string; account: string }>;
}

function makeWorld(): World {
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;
  const tables: Record<string, Row[]> = {
    optionSet: [],
    optionValue: [],
    fieldDefinition: [],
    form: [],
    formField: [],
    conversationFieldValue: [],
    conversation: [],
  };
  const committedAudits: Row[] = [];
  const batches: unknown[][] = [];
  const writes: Array<{ table: string; account: string }> = [];

  const ACCOUNT_SCOPED = new Set([
    'optionSet',
    'fieldDefinition',
    'form',
    'conversation',
    'conversationFieldValue',
    // W30 review: the children carry account_id THEMSELVES (the coverage guard caught the parent-hop draft).
    'optionValue',
    'formField',
  ]);
  const UNIQUE: Record<string, string[]> = {
    optionSet: ['account_id', 'name'],
    fieldDefinition: ['account_id', 'key'],
    form: ['account_id', 'key'],
  };

  function scopedFor(acc: string): Row {
    const model = (name: string) => {
      // Reproduces what the feature-007 extension does: every scoped table is confined to `acc`,
      // the children included — they carry account_id themselves (the coverage guard's rule).
      const all = () =>
        ACCOUNT_SCOPED.has(name)
          ? tables[name]!.filter((r) => r.account_id === acc)
          : tables[name]!;
      const insert = (data: Row): Row => {
        const row: Row = { id: nextId(name), ...data };
        if (ACCOUNT_SCOPED.has(name)) row.account_id = acc;
        const uniq = UNIQUE[name];
        if (uniq && tables[name]!.some((r) => uniq.every((k) => r[k] === row[k]))) {
          const err = new Error('unique') as Error & { code: string };
          err.code = 'P2002';
          throw err;
        }
        tables[name]!.push(row);
        writes.push({ table: name, account: acc });
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
        createMany: (args: { data: Row[] }) => {
          for (const d of args.data) insert(d);
          return { __stmt: `${name}.createMany` };
        },
        updateMany: (args: { where: Row; data: Row }) => {
          const hits = all().filter((r) => matchesWhere(r, args.where));
          for (const r of hits) Object.assign(r, args.data);
          if (hits.length) writes.push({ table: name, account: acc });
          return { count: hits.length, __stmt: `${name}.updateMany` };
        },
        deleteMany: (args: { where: Row }) => {
          const doomed = all().filter((r) => matchesWhere(r, args.where));
          for (const d of doomed) tables[name]!.splice(tables[name]!.indexOf(d), 1);
          if (doomed.length) writes.push({ table: name, account: acc });
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
          writes.push({ table: name, account: acc });
          return { __stmt: `${name}.upsert` };
        },
      };
    };

    const scoped: Row = {};
    for (const name of Object.keys(tables)) scoped[name] = model(name);
    // The audit statement is BUILT eagerly (the controller does that before validation) but only
    // COUNTS once an executed $transaction carries it — exactly the property under test.
    scoped.auditEntry = { create: (args: { data: Row }) => ({ __audit: args.data }) };
    scoped.$transaction = (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(scoped);
      const batch = arg as unknown[];
      batches.push(batch);
      for (const stmt of batch) {
        if (stmt && typeof stmt === 'object' && '__audit' in (stmt as Row)) {
          committedAudits.push((stmt as { __audit: Row }).__audit);
        }
      }
      return Promise.resolve(batch.map((s) => s ?? {}));
    };
    return scoped;
  }

  const forAccount = jest.fn((acc: string) => scopedFor(acc));
  const prisma = { forAccount } as unknown as PrismaService;
  return { prisma, forAccount, tables, committedAudits, batches, writes };
}

const build = (w: World) =>
  new FieldsAdminController(new FieldsRepository(w.prisma), new AuditRepository(w.prisma));

function md(perms: string[], accountId = 'acc-1'): Metadata {
  const m = new Metadata();
  m.set('x-actor-account-id', accountId);
  m.set('x-actor-user-id', 'u-admin');
  m.set('x-actor-permissions', perms.join(','));
  return m;
}

const ADMIN = ['platform.field.manage'];
const TEAMLEAD = ['crm.inbox.view', 'crm.conversation.reply', 'crm.templates.manage'];

async function refusalOf(p: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RpcException);
    return (e as RpcException).getError() as { code: number; message: string };
  }
  throw new Error('expected a refusal, got a success');
}

// ── fixture helpers writing straight into the store (arrange, not act) ──────────────────────────
function seedSet(w: World, acc: string, id: string, name: string, values: string[]): void {
  w.tables.optionSet!.push({ id, account_id: acc, name });
  values.forEach((value, i) =>
    w.tables.optionValue!.push({ id: `${id}-v${i}`, account_id: acc, option_set_id: id, value, order: i, active: true }),
  );
}
function seedField(w: World, acc: string, over: Row): Row {
  const row: Row = {
    id: `fd-${w.tables.fieldDefinition!.length + 1}`,
    account_id: acc,
    key: 'k',
    label: 'K',
    type: 'text',
    required: false,
    restricted: false,
    option_set_id: null,
    brand_ids: [],
    active: true,
    ...over,
  };
  w.tables.fieldDefinition!.push(row);
  return row;
}

describe('*** authoring is refused below `platform.field.manage` (server-side, both tiers) ***', () => {
  const guardCtx = (handler: unknown, perms: string[]) =>
    ({
      getType: () => 'rpc',
      getHandler: () => handler,
      getClass: () => FieldsAdminController,
      switchToRpc: () => ({ getContext: () => md(perms) }),
    }) as never;

  const HANDLERS = [
    FieldsAdminController.prototype.getFieldConfiguration,
    FieldsAdminController.prototype.upsertFieldDefinition,
    FieldsAdminController.prototype.upsertOptionSet,
    FieldsAdminController.prototype.deleteOptionSet,
    FieldsAdminController.prototype.upsertForm,
  ];

  it('⭐ the guard refuses every rpc for a teamlead-shaped set; admin is the positive control', () => {
    const guard = new ChatsAccessGuard(new Reflector());
    for (const h of HANDLERS) {
      expect(() => guard.canActivate(guardCtx(h, TEAMLEAD))).toThrow(RpcException);
      expect(guard.canActivate(guardCtx(h, ADMIN))).toBe(true);
    }
  });

  it('all five handlers declare the one configuration key', () => {
    const reflector = new Reflector();
    for (const h of HANDLERS) {
      expect(reflector.get<string>(REQUIRED_CHATS_PERMISSION_KEY, h)).toBe('platform.field.manage');
    }
  });
});

describe('⭐ the happy path: set → field → form, keys derived, audits committed in-batch', () => {
  it('creates all three, reads the same structure back, and audits each act with actor + target', async () => {
    const w = makeWorld();
    const ctrl = build(w);

    const set = await ctrl.upsertOptionSet(
      { id: '', name: 'Deposit status', values: [{ value: 'Declined' }, { value: 'Pending' }, { value: 'Approved' }] },
      md(ADMIN),
    );
    expect(set.id).toBeTruthy();
    expect(set.values.map((v: { value: string }) => v.value)).toEqual(['Declined', 'Pending', 'Approved']);

    const field = await ctrl.upsertFieldDefinition(
      { key: '', label: 'Deposit status', type: 'dropdown', required: true, optionSetId: set.id },
      md(ADMIN),
    );
    // The key IS the label, normalised — never caller-chosen.
    expect(field.key).toBe('deposit_status');
    expect(field).toMatchObject({ type: 'dropdown', required: true, optionSetId: set.id, active: true });

    const form = await ctrl.upsertForm(
      {
        key: '',
        name: 'Deposits',
        category: 'Deposits',
        entries: [{ fieldKey: 'deposit_status', isSubcategorySource: true }],
      },
      md(ADMIN),
    );
    expect(form.key).toBe('deposits');
    expect(form.category).toBe('Deposits');
    expect(form.entries).toEqual([
      {
        fieldKey: 'deposit_status',
        order: 0,
        conditionFieldKey: '',
        conditionValue: '',
        isSubcategorySource: true,
      },
    ]);

    // Read back through the one admin projection: same structure, not an echo of the request.
    const cfg = await ctrl.getFieldConfiguration({}, md(ADMIN));
    expect(cfg.optionSets).toHaveLength(1);
    expect(cfg.fields.map((f: { key: string }) => f.key)).toEqual(['deposit_status']);
    expect(cfg.forms).toHaveLength(1);
    expect(cfg.forms[0]!.entries[0]).toMatchObject({ fieldKey: 'deposit_status', isSubcategorySource: true });

    // Three successful writes ⇒ three COMMITTED audit statements, right action, right target.
    expect(w.committedAudits.map((a) => a.action)).toEqual([
      'option_set.config_changed',
      'field.config_changed',
      'form.config_changed',
    ]);
    for (const a of w.committedAudits) {
      expect(a.actor_user_id).toBe('u-admin');
      expect(a.target_ref).toBe('created'); // creates: the key does not exist before the batch
    }
  });

  it('an EDIT audits with the key as target_ref', async () => {
    const w = makeWorld();
    seedField(w, 'acc-1', { id: 'fd-note', key: 'player_note', label: 'Player note', type: 'text' });
    await build(w).upsertFieldDefinition(
      { key: 'player_note', label: 'Player note (edited)', type: 'text' },
      md(ADMIN),
    );
    expect(w.committedAudits).toHaveLength(1);
    expect(w.committedAudits[0]).toMatchObject({ action: 'field.config_changed', target_ref: 'player_note' });
  });
});

describe('worded refusals — and a refusal commits NOTHING, audit included', () => {
  it('a dropdown without an option set is refused', async () => {
    const w = makeWorld();
    const e = await refusalOf(
      build(w).upsertFieldDefinition({ key: '', label: 'Bad dropdown', type: 'dropdown' }, md(ADMIN)),
    );
    expect(e).toEqual({ code: GrpcStatus.INVALID_ARGUMENT, message: 'a dropdown field needs an option set' });
    expect(w.committedAudits).toHaveLength(0);
    expect(w.writes).toHaveLength(0);
  });

  it('an unknown type is refused, never defaulted', async () => {
    const w = makeWorld();
    const e = await refusalOf(
      build(w).upsertFieldDefinition({ key: '', label: 'Check', type: 'checkbox' }, md(ADMIN)),
    );
    expect(e).toEqual({ code: GrpcStatus.INVALID_ARGUMENT, message: 'unknown field type' });
    expect(w.writes).toHaveLength(0);
  });

  it('⭐ the TYPE is immutable on update — refused in words that name the way out', async () => {
    const w = makeWorld();
    seedField(w, 'acc-1', { id: 'fd-note', key: 'player_note', label: 'Player note', type: 'text' });
    const e = await refusalOf(
      build(w).upsertFieldDefinition({ key: 'player_note', label: 'Player note', type: 'numeric' }, md(ADMIN)),
    );
    expect(e).toEqual({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: 'a field type cannot change — archive and create a new field',
    });
    expect(w.tables.fieldDefinition!.find((f) => f.key === 'player_note')!.type).toBe('text');
    expect(w.committedAudits).toHaveLength(0);
  });

  it('deleting a set a field stands on CONFLICTS', async () => {
    const w = makeWorld();
    seedSet(w, 'acc-1', 'os-1', 'Deposit status', ['Declined']);
    seedField(w, 'acc-1', { key: 'deposit_status', label: 'Deposit status', type: 'dropdown', option_set_id: 'os-1' });
    const e = await refusalOf(build(w).deleteOptionSet({ id: 'os-1' }, md(ADMIN)));
    expect(e).toEqual({ code: GrpcStatus.ALREADY_EXISTS, message: 'the option set is referenced by a field' });
    expect(w.tables.optionSet!).toHaveLength(1); // still there
  });

  it('⭐ removing a value IN USE conflicts and names deactivation; deactivating it succeeds', async () => {
    const w = makeWorld();
    seedSet(w, 'acc-1', 'os-1', 'Deposit status', ['Declined', 'Pending']);
    const field = seedField(w, 'acc-1', {
      key: 'deposit_status',
      label: 'Deposit status',
      type: 'dropdown',
      option_set_id: 'os-1',
    });
    w.tables.conversationFieldValue!.push({
      id: 'cfv-1',
      account_id: 'acc-1',
      conversation_id: 'c-1',
      field_id: field.id,
      value: 'Declined',
    });

    // Removal (the value disappears from the request) — refused because a ticket already says it.
    const e = await refusalOf(
      // `replaceValues` is the explicit act (post-review contract): without it this update would be
      // refused as a rename that smuggled a composition, which is its own test elsewhere.
      build(w).upsertOptionSet(
        { id: 'os-1', name: 'Deposit status', values: [{ value: 'Pending' }], replaceValues: true },
        md(ADMIN),
      ),
    );
    expect(e).toEqual({
      code: GrpcStatus.ALREADY_EXISTS,
      message: 'a value in use can only be deactivated, not removed',
    });
    expect(w.tables.optionValue!.some((v) => v.value === 'Declined')).toBe(true);

    // The way out the refusal names: deactivate.
    const res = await build(w).upsertOptionSet(
      {
        id: 'os-1',
        name: 'Deposit status',
        values: [{ value: 'Declined', active: false }, { value: 'Pending' }],
        replaceValues: true,
      },
      md(ADMIN),
    );
    expect(res.values).toContainEqual(expect.objectContaining({ value: 'Declined', active: false }));
  });

  it('⭐ a rename-only edit (no replace_values) leaves the stored values UNTOUCHED', async () => {
    // The review finding this pins: proto3 cannot tell an absent list from an empty one, so a bare
    // rename/archive PATCH used to read as "every value disappeared" and silently deleted the
    // unused ones. Absence must be an act: the flag says "this request carries the composition".
    const w = makeWorld();
    seedSet(w, 'acc-1', 'os-1', 'Deposit status', ['Declined', 'Pending']);
    const res = await build(w).upsertOptionSet(
      { id: 'os-1', name: 'Deposit outcome', values: [], replaceValues: false },
      md(ADMIN),
    );
    expect(res.name).toBe('Deposit outcome');
    expect(w.tables.optionValue!.map((v) => v.value).sort()).toEqual(['Declined', 'Pending']);

    // …and values smuggled WITHOUT the flag are refused, never silently ignored.
    const e = await refusalOf(
      build(w).upsertOptionSet(
        { id: 'os-1', name: 'Deposit outcome', values: [{ value: 'X' }], replaceValues: false },
        md(ADMIN),
      ),
    );
    expect(e).toEqual({ code: GrpcStatus.INVALID_ARGUMENT, message: 'values sent without replace_values' });
  });

  it('⭐ an archive PATCH (no replace_entries) keeps the form’s COMPOSITION', async () => {
    const w = makeWorld();
    seedSet(w, 'acc-1', 'os-1', 'Set', ['A']);
    seedField(w, 'acc-1', { key: 'dd_one', label: 'One', type: 'dropdown', option_set_id: 'os-1' });
    await build(w).upsertForm(
      { key: '', name: 'Deposits', category: 'Deposits', entries: [{ fieldKey: 'dd_one' }] },
      md(ADMIN),
    );
    expect(w.tables.formField!).toHaveLength(1);

    await build(w).upsertForm(
      { key: 'deposits', name: 'Deposits', category: 'Deposits', active: false, replaceEntries: false },
      md(ADMIN),
    );
    const form = w.tables.form!.find((f) => f.key === 'deposits')!;
    expect(form.active).toBe(false);
    expect(w.tables.formField!).toHaveLength(1); // the structure survived the archive
  });

  it('a form with two sub-category sources is refused', async () => {
    const w = makeWorld();
    seedSet(w, 'acc-1', 'os-1', 'Set', ['A']);
    seedField(w, 'acc-1', { key: 'dd_one', label: 'One', type: 'dropdown', option_set_id: 'os-1' });
    seedField(w, 'acc-1', { key: 'dd_two', label: 'Two', type: 'dropdown', option_set_id: 'os-1' });
    const e = await refusalOf(
      build(w).upsertForm(
        {
          key: '',
          name: 'Doubles',
          entries: [
            { fieldKey: 'dd_one', isSubcategorySource: true },
            { fieldKey: 'dd_two', isSubcategorySource: true },
          ],
        },
        md(ADMIN),
      ),
    );
    expect(e).toEqual({
      code: GrpcStatus.INVALID_ARGUMENT,
      message: 'a form designates at most one sub-category source',
    });
    expect(w.tables.form!).toHaveLength(0);
  });

  it('a condition whose parent is not a dropdown is refused', async () => {
    const w = makeWorld();
    seedField(w, 'acc-1', { key: 'amount', label: 'Amount', type: 'numeric' });
    seedField(w, 'acc-1', { key: 'note', label: 'Note', type: 'text' });
    const e = await refusalOf(
      build(w).upsertForm(
        {
          key: '',
          name: 'Bad parent',
          entries: [
            { fieldKey: 'amount' },
            { fieldKey: 'note', conditionFieldKey: 'amount', conditionValue: '5' },
          ],
        },
        md(ADMIN),
      ),
    );
    expect(e).toEqual({ code: GrpcStatus.INVALID_ARGUMENT, message: 'a condition parent must be a dropdown' });
  });

  it('a condition cycle is refused — a form no value can ever unlock', async () => {
    const w = makeWorld();
    seedSet(w, 'acc-1', 'os-1', 'Set', ['A', 'B']);
    seedField(w, 'acc-1', { key: 'dd_one', label: 'One', type: 'dropdown', option_set_id: 'os-1' });
    seedField(w, 'acc-1', { key: 'dd_two', label: 'Two', type: 'dropdown', option_set_id: 'os-1' });
    const e = await refusalOf(
      build(w).upsertForm(
        {
          key: '',
          name: 'Cycle',
          entries: [
            { fieldKey: 'dd_one', conditionFieldKey: 'dd_two', conditionValue: 'A' },
            { fieldKey: 'dd_two', conditionFieldKey: 'dd_one', conditionValue: 'B' },
          ],
        },
        md(ADMIN),
      ),
    );
    expect(e).toEqual({ code: GrpcStatus.INVALID_ARGUMENT, message: 'conditions form a cycle' });
  });
});

describe('037 isolation — account B is structurally unreachable (the file-9 assertions live here)', () => {
  function foreignWorld(): World {
    const w = makeWorld();
    // acc-2 owns a full structure; ids and keys are the ones acc-1 might guess.
    seedSet(w, 'acc-2', 'os-foreign', 'Their set', ['Theirs']);
    seedField(w, 'acc-2', { key: 'their_field', label: 'Their field', type: 'dropdown', option_set_id: 'os-foreign' });
    w.tables.form!.push({
      id: 'form-foreign',
      account_id: 'acc-2',
      key: 'their_form',
      name: 'Their form',
      category: 'Theirs',
      active: true,
      order: 10,
    });
    return w;
  }

  it('the configuration read of account A lists NONE of account B rows', async () => {
    const w = foreignWorld();
    const cfg = await build(w).getFieldConfiguration({}, md(ADMIN, 'acc-1'));
    expect(cfg.optionSets).toEqual([]);
    expect(cfg.fields).toEqual([]);
    expect(cfg.forms).toEqual([]);
  });

  it('editing account B field by key is NOT_FOUND; referencing B set by id is NOT_FOUND', async () => {
    const w = foreignWorld();
    // `text`, deliberately: the shape checks (a dropdown needs its set) run BEFORE existence, so a
    // dropdown probe would be refused for its shape and prove nothing about scoping.
    const byKey = await refusalOf(
      build(w).upsertFieldDefinition({ key: 'their_field', label: 'X', type: 'text' }, md(ADMIN, 'acc-1')),
    );
    expect(byKey).toEqual({ code: GrpcStatus.NOT_FOUND, message: 'field not found' });

    const bySetId = await refusalOf(
      build(w).upsertFieldDefinition(
        { key: '', label: 'Mine', type: 'dropdown', optionSetId: 'os-foreign' },
        md(ADMIN, 'acc-1'),
      ),
    );
    expect(bySetId).toEqual({ code: GrpcStatus.NOT_FOUND, message: 'option set not found' });

    const del = await refusalOf(build(w).deleteOptionSet({ id: 'os-foreign' }, md(ADMIN, 'acc-1')));
    expect(del.code).toBe(GrpcStatus.NOT_FOUND);

    // Nothing of account B moved, and no write happened as anyone.
    expect(w.writes).toHaveLength(0);
    expect(w.tables.optionSet!.find((s) => s.id === 'os-foreign')).toBeDefined();
    expect(w.forAccount.mock.calls.every((c) => c[0] === 'acc-1')).toBe(true);
  });

  it('the same NAME may exist in both accounts — creating ours is no conflict with theirs', async () => {
    const w = foreignWorld();
    const res = await build(w).upsertOptionSet(
      { id: '', name: 'Their set', values: [{ value: 'Ours' }] },
      md(ADMIN, 'acc-1'),
    );
    expect(res.name).toBe('Their set');
    // Two rows now, one per account.
    expect(w.tables.optionSet!.filter((s) => s.name === 'Their set')).toHaveLength(2);
  });
});
