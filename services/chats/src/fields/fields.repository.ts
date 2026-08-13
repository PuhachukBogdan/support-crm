import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { FIELD_TYPES, isFieldType, isNumericFieldValue, type FieldType } from '@crm/common';
import { PrismaService } from '../prisma.service';
import {
  classificationLock,
  classifiedByOf,
  type ClassificationActor,
} from './classification-write';

/**
 * ⭐ Feature 037 (roadmap 4.15 — W30): custom ticket fields, forms & option sets.
 *
 * ── The two-level model, enforced here ───────────────────────────────────────────────────────────
 * The only closed vocabulary is the field TYPE (`libs/common/src/fields`). Everything this
 * repository touches is per-account rows, and nothing in it compares a field key or a form key to a
 * literal — `tests/fields/no-field-key-branch.spec.ts` scans for exactly that.
 *
 * ── Every read is account-scoped, no method-level exception ──────────────────────────────────────
 * Like statuses: a field only means anything to the account that configured it. Child tables
 * without their own `account_id` (OptionValue, FormField) are reached ONLY through parents resolved
 * in-scope first — a foreign id resolves to null and fails closed.
 *
 * ── Refusals are typed, worded, and carry no submitted value ─────────────────────────────────────
 * The controllers map `FieldsRefusal` to gRPC codes. Messages are LITERALS (the status-admin rule):
 * an interpolated message is one refactor away from carrying a customer's value into a log.
 *
 * ── Archive over delete (criterion ①) ────────────────────────────────────────────────────────────
 * Fields and forms only ever flip `active`. An option value in use deactivates. The single hard
 * delete — an unreferenced option set — refuses the moment any field stands on it.
 */

export class FieldsRefusal extends Error {
  constructor(
    readonly kind: 'invalid' | 'not_found' | 'conflict' | 'precondition',
    message: string,
  ) {
    super(message);
  }
}

/** A label is a word or two a reader scans; longer is prose (the status-admin rule). */
const MAX_NAME = 80;
/** One dropdown choice — a phrase, not a paragraph. */
const MAX_OPTION_VALUE = 120;
/** A stored field value. Multiline is the widest customer of this cap. */
const MAX_VALUE = 2000;

/** The key IS the name, normalised — never caller-chosen (the status-admin derivation, verbatim). */
export function keyFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

function assertName(message: string, value: string): void {
  if (!value || value.length > MAX_NAME) throw new FieldsRefusal('invalid', message);
}

// ── row shapes (selects stated once) ────────────────────────────────────────────────────────────

const FIELD_SELECT = {
  id: true,
  key: true,
  label: true,
  type: true,
  required: true,
  restricted: true,
  option_set_id: true,
  brand_ids: true,
  active: true,
} as const;

export interface FieldRow {
  id: string;
  key: string;
  label: string;
  type: string;
  required: boolean;
  restricted: boolean;
  option_set_id: string | null;
  brand_ids: string[];
  active: boolean;
}

const ENTRY_SELECT = {
  field_id: true,
  order: true,
  condition_field_id: true,
  condition_value: true,
  is_subcategory_source: true,
} as const;

export interface EntryRow {
  field_id: string;
  order: number;
  condition_field_id: string | null;
  condition_value: string | null;
  is_subcategory_source: boolean;
}

const FORM_SELECT = {
  id: true,
  key: true,
  name: true,
  category: true,
  active: true,
  order: true,
} as const;

export interface FormRow {
  id: string;
  key: string;
  name: string;
  category: string | null;
  active: boolean;
  order: number;
}

export interface OptionValueRow {
  value: string;
  order: number;
  active: boolean;
}

export interface UpsertFieldInput {
  key: string;
  label: string;
  type: string;
  required: boolean;
  restricted: boolean;
  optionSetId: string;
  brandIds: string[];
  active: boolean;
}

export interface UpsertFormEntryInput {
  fieldKey: string;
  order: number;
  conditionFieldKey: string;
  conditionValue: string;
  isSubcategorySource: boolean;
}

export interface UpsertFormInput {
  key: string;
  name: string;
  category: string;
  active: boolean;
  order: number;
  entries: UpsertFormEntryInput[];
  /** TRUE = `entries` IS the composition; FALSE on update = structure untouched (criterion ①). */
  replaceEntries: boolean;
}

@Injectable()
export class FieldsRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // ── the authoring projection (one read for the whole screen) ──────────────────────────────────

  async configuration(accountId: string) {
    const db = this.prisma.forAccount(accountId);
    const sets = (await db.optionSet.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    })) as Array<{ id: string; name: string }>;
    const values = (await db.optionValue.findMany({
      where: { option_set_id: { in: sets.map((s) => s.id) } },
      orderBy: [{ order: 'asc' }, { value: 'asc' }],
      select: { option_set_id: true, value: true, order: true, active: true },
    })) as Array<OptionValueRow & { option_set_id: string }>;
    const fields = (await db.fieldDefinition.findMany({
      orderBy: { label: 'asc' },
      select: FIELD_SELECT,
    })) as FieldRow[];
    const forms = (await db.form.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      select: FORM_SELECT,
    })) as FormRow[];
    const entries = (await db.formField.findMany({
      where: { form_id: { in: forms.map((f) => f.id) } },
      orderBy: { order: 'asc' },
      select: { form_id: true, ...ENTRY_SELECT },
    })) as Array<EntryRow & { form_id: string }>;
    return { sets, values, fields, forms, entries };
  }

  async fieldByKey(accountId: string, key: string): Promise<FieldRow | null> {
    if (!key) return null;
    return (await this.prisma.forAccount(accountId).fieldDefinition.findFirst({
      where: { key },
      select: FIELD_SELECT,
    })) as FieldRow | null;
  }

  async formByKey(accountId: string, key: string): Promise<FormRow | null> {
    if (!key) return null;
    return (await this.prisma.forAccount(accountId).form.findFirst({
      where: { key },
      select: FORM_SELECT,
    })) as FormRow | null;
  }

  /**
   * The account's category VOCABULARY — the distinct categories its active forms carry. Consumed by
   * the macro define validator (FR-017): now that a vocabulary exists, a SET_CATEGORY value outside
   * it is refused at authoring time (the `Billing`-vs-`billing` seed drift is the warning).
   */
  async activeFormCategories(accountId: string): Promise<string[]> {
    const rows = (await this.prisma.forAccount(accountId).form.findMany({
      where: { active: true, category: { not: null } },
      select: { category: true },
    })) as Array<{ category: string | null }>;
    return [...new Set(rows.map((r) => r.category).filter((c): c is string => !!c))];
  }

  // ── authoring: field definitions ───────────────────────────────────────────────────────────────

  /**
   * Create (`key === ''` — the key derives from the label) or edit-by-key. The TYPE is immutable
   * after creation: values already stored under one validation rule must not silently start
   * meaning another (archive the field and create a new one — the archive path exists for this).
   */
  async upsertField(
    accountId: string,
    input: UpsertFieldInput,
    auditStatement: unknown,
  ): Promise<FieldRow> {
    const db = this.prisma.forAccount(accountId);
    const label = input.label.trim();
    assertName('invalid label', label);
    if (!isFieldType(input.type)) throw new FieldsRefusal('invalid', 'unknown field type');
    const type: FieldType = input.type;

    const optionSetId = input.optionSetId.trim();
    if (FIELD_TYPES[type].hasOptions) {
      if (!optionSetId) throw new FieldsRefusal('invalid', 'a dropdown field needs an option set');
      const set = await db.optionSet.findFirst({ where: { id: optionSetId }, select: { id: true } });
      if (!set) throw new FieldsRefusal('not_found', 'option set not found');
    } else if (optionSetId) {
      throw new FieldsRefusal('invalid', 'only a dropdown field references an option set');
    }
    const brandIds = input.brandIds.map((b) => b.trim()).filter(Boolean);

    if (!input.key) {
      const key = keyFromName(label);
      if (!key) throw new FieldsRefusal('invalid', 'label yields no key');
      try {
        await db.$transaction([
          db.fieldDefinition.create({
            data: {
              account_id: accountId,
              key,
              label,
              type,
              required: input.required,
              restricted: input.restricted,
              option_set_id: optionSetId || null,
              brand_ids: brandIds,
              active: input.active,
            },
          }),
          auditStatement,
        ] as never);
      } catch (e) {
        if ((e as { code?: string })?.code === 'P2002') {
          throw new FieldsRefusal('conflict', 'a field with this name already exists');
        }
        throw e;
      }
      return (await this.fieldByKey(accountId, key))!;
    }

    const existing = await this.fieldByKey(accountId, input.key);
    if (!existing) throw new FieldsRefusal('not_found', 'field not found');
    if (existing.type !== type) {
      throw new FieldsRefusal('invalid', 'a field type cannot change — archive and create a new field');
    }
    await db.$transaction([
      db.fieldDefinition.updateMany({
        where: { key: input.key },
        data: {
          label,
          required: input.required,
          restricted: input.restricted,
          option_set_id: optionSetId || null,
          brand_ids: brandIds,
          active: input.active,
        },
      }),
      auditStatement,
    ] as never);
    return (await this.fieldByKey(accountId, input.key))!;
  }

  // ── authoring: option sets ─────────────────────────────────────────────────────────────────────

  /**
   * When `replaceValues` is set, the whole list arrives and the service diffs (atomic — no partial
   * value writes): new values are inserted, present ones keep/update `order` + `active`, and a
   * value that DISAPPEARED from the request is deleted only while unused — if any conversation
   * holds it, the write refuses and names the way out (deactivate), because an authoring act must
   * never rewrite what a ticket already says.
   *
   * ⚠️ Without the flag, an UPDATE is a rename-only edit and the stored values are untouched —
   * proto3 cannot tell an absent list from an empty one, and a wiped composition must be an act,
   * never an omission (found by W30's own test pass). Values sent WITHOUT the flag are refused
   * rather than silently ignored: a request must not look like it did something it did not.
   */
  async upsertOptionSet(
    accountId: string,
    input: { id: string; name: string; values: OptionValueRow[]; replaceValues: boolean },
    auditStatement: unknown,
  ): Promise<{ id: string; name: string }> {
    const db = this.prisma.forAccount(accountId);
    const name = input.name.trim();
    assertName('invalid name', name);
    if (!input.replaceValues && input.values.length > 0) {
      throw new FieldsRefusal('invalid', 'values sent without replace_values');
    }

    const incoming = input.values.map((v, i) => ({
      value: v.value.trim(),
      order: Number.isFinite(v.order) ? v.order : i,
      active: v.active !== false,
    }));
    for (const v of incoming) {
      if (!v.value || v.value.length > MAX_OPTION_VALUE) {
        throw new FieldsRefusal('invalid', 'invalid option value');
      }
    }
    if (new Set(incoming.map((v) => v.value)).size !== incoming.length) {
      throw new FieldsRefusal('invalid', 'duplicate option value');
    }

    if (!input.id) {
      // The id is minted HERE so the set, its values and the audit entry ride ONE batch — the
      // statuses shape; an interactive transaction would buy nothing but a second commit to lose.
      const setId = randomUUID();
      try {
        await db.$transaction([
          db.optionSet.create({ data: { id: setId, account_id: accountId, name } }),
          ...(incoming.length
            ? [
                db.optionValue.createMany({
                  data: incoming.map((v) => ({ option_set_id: setId, ...v })),
                }),
              ]
            : []),
          auditStatement,
        ] as never);
      } catch (e) {
        if ((e as { code?: string })?.code === 'P2002') {
          throw new FieldsRefusal('conflict', 'an option set with this name already exists');
        }
        throw e;
      }
      return { id: setId, name };
    }

    const set = (await db.optionSet.findFirst({
      where: { id: input.id },
      select: { id: true, name: true },
    })) as { id: string; name: string } | null;
    if (!set) throw new FieldsRefusal('not_found', 'option set not found');

    // Rename-only edit: the stored values are not read, not diffed, not touched.
    if (!input.replaceValues) {
      if (name !== set.name) {
        try {
          await db.$transaction([
            db.optionSet.updateMany({ where: { id: set.id }, data: { name } }),
            auditStatement,
          ] as never);
        } catch (e) {
          if ((e as { code?: string })?.code === 'P2002') {
            throw new FieldsRefusal('conflict', 'an option set with this name already exists');
          }
          throw e;
        }
      }
      return { id: set.id, name };
    }

    const existing = (await db.optionValue.findMany({
      where: { option_set_id: set.id },
      select: { id: true, value: true, order: true, active: true },
    })) as Array<{ id: string; value: string; order: number; active: boolean }>;
    const incomingByValue = new Map(incoming.map((v) => [v.value, v]));
    const removed = existing.filter((e) => !incomingByValue.has(e.value));

    if (removed.length) {
      const referencingFields = (await db.fieldDefinition.findMany({
        where: { option_set_id: set.id },
        select: { id: true },
      })) as Array<{ id: string }>;
      const used = (await db.conversationFieldValue.findFirst({
        where: {
          field_id: { in: referencingFields.map((f) => f.id) },
          value: { in: removed.map((r) => r.value) },
        },
        select: { id: true },
      })) as { id: string } | null;
      if (used) {
        throw new FieldsRefusal('conflict', 'a value in use can only be deactivated, not removed');
      }
    }

    const statements: unknown[] = [];
    if (name !== set.name) {
      statements.push(db.optionSet.updateMany({ where: { id: set.id }, data: { name } }));
    }
    for (const r of removed) statements.push(db.optionValue.deleteMany({ where: { id: r.id } }));
    for (const v of incoming) {
      const match = existing.find((e) => e.value === v.value);
      if (!match) {
        statements.push(db.optionValue.create({ data: { option_set_id: set.id, ...v } }));
      } else if (match.order !== v.order || match.active !== v.active) {
        statements.push(
          db.optionValue.updateMany({
            where: { id: match.id },
            data: { order: v.order, active: v.active },
          }),
        );
      }
    }
    try {
      await db.$transaction([...statements, auditStatement] as never);
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        throw new FieldsRefusal('conflict', 'an option set with this name already exists');
      }
      throw e;
    }
    return { id: set.id, name };
  }

  /** Hard delete — the ONLY one in this module — refused the moment any field stands on the set. */
  async deleteOptionSet(accountId: string, id: string, auditStatement: unknown): Promise<void> {
    const db = this.prisma.forAccount(accountId);
    const set = await db.optionSet.findFirst({ where: { id }, select: { id: true } });
    if (!set) throw new FieldsRefusal('not_found', 'option set not found');
    const referencing = await db.fieldDefinition.findFirst({
      where: { option_set_id: id },
      select: { key: true },
    });
    if (referencing) {
      throw new FieldsRefusal('conflict', 'the option set is referenced by a field');
    }
    await db.$transaction([db.optionSet.deleteMany({ where: { id } }), auditStatement] as never);
  }

  // ── authoring: forms ───────────────────────────────────────────────────────────────────────────

  /**
   * When the composition arrives (`replaceEntries`, or a CREATE — where the request IS the
   * composition), entries are replaced wholesale in one transaction (all-or-nothing — the spec's
   * "no partial composite writes"). Validation before any write: every referenced field exists;
   * ≤1 sub-category source and it is a dropdown; a condition names another dropdown ENTRY of this
   * same form, both halves or neither, and the parent chain terminates (no cycles — a cycle would
   * be a form no value can ever unlock).
   *
   * ⚠️ An UPDATE without the flag edits name/category/active/order and leaves the stored entries
   * alone — an archive PATCH must not destroy a form's structure (criterion ①; the
   * `replaceValues` reasoning, second instance). Entries sent WITHOUT the flag are refused.
   */
  async upsertForm(
    accountId: string,
    input: UpsertFormInput,
    auditStatement: unknown,
  ): Promise<FormRow> {
    const db = this.prisma.forAccount(accountId);
    const name = input.name.trim();
    assertName('invalid name', name);
    const category = input.category.trim();
    if (category.length > MAX_NAME) throw new FieldsRefusal('invalid', 'invalid category');
    const composing = !input.key || input.replaceEntries;
    if (!composing && input.entries.length > 0) {
      throw new FieldsRefusal('invalid', 'entries sent without replace_entries');
    }

    const fieldKeys = input.entries.map((e) => e.fieldKey.trim());
    if (new Set(fieldKeys).size !== fieldKeys.length) {
      throw new FieldsRefusal('invalid', 'a field appears twice on the form');
    }
    const fields = (await db.fieldDefinition.findMany({
      where: { key: { in: fieldKeys } },
      select: { id: true, key: true, type: true },
    })) as Array<{ id: string; key: string; type: string }>;
    const fieldByKey = new Map(fields.map((f) => [f.key, f]));
    for (const key of fieldKeys) {
      if (!fieldByKey.has(key)) throw new FieldsRefusal('not_found', 'unknown field on the form');
    }

    const sources = input.entries.filter((e) => e.isSubcategorySource);
    if (sources.length > 1) {
      throw new FieldsRefusal('invalid', 'a form designates at most one sub-category source');
    }
    if (sources.length === 1 && fieldByKey.get(sources[0]!.fieldKey.trim())!.type !== 'dropdown') {
      throw new FieldsRefusal('invalid', 'the sub-category source must be a dropdown');
    }

    const entryByKey = new Map(input.entries.map((e) => [e.fieldKey.trim(), e]));
    for (const e of input.entries) {
      const parentKey = e.conditionFieldKey.trim();
      const parentValue = e.conditionValue.trim();
      if (!parentKey !== !parentValue) {
        throw new FieldsRefusal('invalid', 'a condition needs both its field and its value');
      }
      if (!parentKey) continue;
      if (parentKey === e.fieldKey.trim()) {
        throw new FieldsRefusal('invalid', 'a field cannot condition on itself');
      }
      const parent = entryByKey.get(parentKey);
      if (!parent) throw new FieldsRefusal('invalid', 'a condition must name a field of this form');
      if (fieldByKey.get(parentKey)!.type !== 'dropdown') {
        throw new FieldsRefusal('invalid', 'a condition parent must be a dropdown');
      }
      // Walk to the root; revisiting a key is a cycle.
      const seen = new Set<string>([e.fieldKey.trim()]);
      let cursor: UpsertFormEntryInput | undefined = parent;
      while (cursor) {
        const k: string = cursor.fieldKey.trim();
        if (seen.has(k)) throw new FieldsRefusal('invalid', 'conditions form a cycle');
        seen.add(k);
        cursor = cursor.conditionFieldKey.trim()
          ? entryByKey.get(cursor.conditionFieldKey.trim())
          : undefined;
      }
    }

    const entryData = (formId: string) =>
      input.entries.map((e, i) => ({
        form_id: formId,
        field_id: fieldByKey.get(e.fieldKey.trim())!.id,
        order: Number.isFinite(e.order) ? e.order : i,
        condition_field_id: e.conditionFieldKey.trim()
          ? fieldByKey.get(e.conditionFieldKey.trim())!.id
          : null,
        condition_value: e.conditionValue.trim() || null,
        is_subcategory_source: e.isSubcategorySource === true,
      }));

    if (!input.key) {
      const key = keyFromName(name);
      if (!key) throw new FieldsRefusal('invalid', 'name yields no key');
      const top = (await db.form.findFirst({
        orderBy: { order: 'desc' },
        select: { order: true },
      })) as { order: number } | null;
      // Minted id ⇒ the form, its entries and the audit entry ride ONE batch (the statuses shape).
      const formId = randomUUID();
      try {
        await db.$transaction([
          db.form.create({
            data: {
              id: formId,
              account_id: accountId,
              key,
              name,
              category: category || null,
              active: input.active,
              order: input.order || (top?.order ?? 0) + 10,
            },
          }),
          ...(input.entries.length ? [db.formField.createMany({ data: entryData(formId) })] : []),
          auditStatement,
        ] as never);
      } catch (e) {
        if ((e as { code?: string })?.code === 'P2002') {
          throw new FieldsRefusal('conflict', 'a form with this name already exists');
        }
        throw e;
      }
      return (await this.formByKey(accountId, key))!;
    }

    const existing = await this.formByKey(accountId, input.key);
    if (!existing) throw new FieldsRefusal('not_found', 'form not found');
    try {
      await db.$transaction([
        db.form.updateMany({
          where: { key: input.key },
          data: {
            name,
            category: category || null,
            active: input.active,
            order: input.order || existing.order,
          },
        }),
        // The stored composition is touched ONLY when the request carried one (replace_entries).
        ...(composing
          ? [
              db.formField.deleteMany({ where: { form_id: existing.id } }),
              ...(input.entries.length
                ? [db.formField.createMany({ data: entryData(existing.id) })]
                : []),
            ]
          : []),
        auditStatement,
      ] as never);
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') {
        throw new FieldsRefusal('conflict', 'a form with this name already exists');
      }
      throw e;
    }
    return (await this.formByKey(accountId, input.key))!;
  }

  // ── the agent projection ───────────────────────────────────────────────────────────────────────

  /**
   * One conversation's fields, resolved: the form's entries applicable to the conversation's brand,
   * restricted ones withheld per the caller's clearance (absent — not blanked, not disabled), each
   * dropdown's ACTIVE options plus the value this conversation already holds even if deactivated,
   * current values, and the classification echo. Returns null when the conversation is not the
   * caller's account's — indistinguishable from absent (tenant isolation as a shape).
   */
  async conversationFieldView(
    accountId: string,
    conversationId: string,
    canSeeRestricted: boolean,
  ) {
    const db = this.prisma.forAccount(accountId);
    const convo = (await db.conversation.findFirst({
      where: { id: conversationId },
      select: {
        id: true,
        brand_id: true,
        form_key: true,
        category: true,
        sub_category: true,
        classified_by: true,
      },
    })) as {
      id: string;
      brand_id: string;
      form_key: string | null;
      category: string | null;
      sub_category: string | null;
      classified_by: string | null;
    } | null;
    if (!convo) return null;

    const availableForms = (await db.form.findMany({
      where: { active: true },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      select: { key: true, name: true },
    })) as Array<{ key: string; name: string }>;

    const empty = {
      formKey: convo.form_key ?? '',
      entries: [] as never[],
      values: [] as Array<{ fieldKey: string; value: string }>,
      category: convo.category ?? '',
      subCategory: convo.sub_category ?? '',
      classifiedBy: convo.classified_by ?? '',
      availableForms,
    };
    if (!convo.form_key) return empty;

    const form = await this.formByKey(accountId, convo.form_key);
    if (!form) return empty; // an archived form's key still on the row — render as unfiled

    const entries = (await db.formField.findMany({
      where: { form_id: form.id },
      orderBy: { order: 'asc' },
      select: ENTRY_SELECT,
    })) as EntryRow[];
    const fields = (await db.fieldDefinition.findMany({
      where: { id: { in: entries.map((e) => e.field_id) } },
      select: FIELD_SELECT,
    })) as FieldRow[];
    const fieldById = new Map(fields.map((f) => [f.id, f]));

    const visible = entries.filter((e) => {
      const f = fieldById.get(e.field_id);
      if (!f || !f.active) return false;
      if (f.restricted && !canSeeRestricted) return false;
      if (f.brand_ids.length && !f.brand_ids.includes(convo.brand_id)) return false;
      return true;
    });

    const valueRows = (await db.conversationFieldValue.findMany({
      where: { conversation_id: conversationId },
      select: { field_id: true, value: true },
    })) as Array<{ field_id: string; value: string }>;
    const valueByFieldId = new Map(valueRows.map((v) => [v.field_id, v.value]));

    const setIds = [
      ...new Set(
        visible
          .map((e) => fieldById.get(e.field_id)!.option_set_id)
          .filter((id): id is string => !!id),
      ),
    ];
    const optionRows = (await db.optionValue.findMany({
      where: { option_set_id: { in: setIds } },
      orderBy: [{ order: 'asc' }, { value: 'asc' }],
      select: { option_set_id: true, value: true, order: true, active: true },
    })) as Array<OptionValueRow & { option_set_id: string }>;

    const heldValueOf = (e: EntryRow, f: FieldRow) =>
      e.is_subcategory_source ? convo.sub_category : (valueByFieldId.get(f.id) ?? null);

    return {
      formKey: convo.form_key,
      entries: visible.map((e) => {
        const f = fieldById.get(e.field_id)!;
        const held = heldValueOf(e, f);
        const options = f.option_set_id
          ? optionRows
              .filter(
                (o) => o.option_set_id === f.option_set_id && (o.active || o.value === held),
              )
              .map((o) => ({ value: o.value, order: o.order, active: o.active }))
          : [];
        return {
          field: toFieldDefWire(f),
          order: e.order,
          conditionFieldKey: e.condition_field_id
            ? (fieldById.get(e.condition_field_id)?.key ?? '')
            : '',
          conditionValue: e.condition_value ?? '',
          isSubcategorySource: e.is_subcategory_source,
          options,
        };
      }),
      values: visible
        .filter((e) => !e.is_subcategory_source && valueByFieldId.has(e.field_id))
        .map((e) => ({
          fieldKey: fieldById.get(e.field_id)!.key,
          value: valueByFieldId.get(e.field_id)!,
        })),
      category: convo.category ?? '',
      subCategory: convo.sub_category ?? '',
      classifiedBy: convo.classified_by ?? '',
      availableForms,
    };
  }

  // ── the two ticket writes ──────────────────────────────────────────────────────────────────────

  /**
   * The form choice. A human choosing a category-bearing form files the conversation (writes
   * `category` + the U9 lock); a category-less form leaves category untouched; `''` clears the
   * choice (stored values REMAIN — a UI act never deletes data). Same-value = idempotent no-op.
   */
  async setConversationForm(
    accountId: string,
    conversationId: string,
    formKey: string,
    actor: ClassificationActor,
  ): Promise<{ changed: boolean }> {
    const db = this.prisma.forAccount(accountId);
    const convo = (await db.conversation.findFirst({
      where: { id: conversationId },
      select: { id: true, form_key: true, shelved_state: true },
    })) as { id: string; form_key: string | null; shelved_state: string | null } | null;
    if (!convo) throw new FieldsRefusal('not_found', 'not found');
    if (convo.shelved_state) throw new FieldsRefusal('precondition', 'conversation is shelved');
    if ((convo.form_key ?? '') === formKey) return { changed: false };

    const data: Record<string, unknown> = { form_key: formKey || null };
    if (formKey) {
      const form = (await db.form.findFirst({
        where: { key: formKey, active: true },
        select: { category: true },
      })) as { category: string | null } | null;
      if (!form) throw new FieldsRefusal('not_found', 'form not found');
      if (form.category) {
        data.category = form.category;
        data.classified_by = classifiedByOf(actor);
      }
    }
    await db.conversation.updateMany({
      where: { id: conversationId, ...(data.category ? classificationLock(actor) : {}) },
      data,
    });
    return { changed: true };
  }

  /**
   * One field value. Validation is fail-closed at every step (spec FR-009); the sub-category
   * source routes to the reserved column (FR-012); a parent change clears every dependent whose
   * condition no longer holds, RECURSIVELY, in the same transaction (FR-008); the identical value
   * is an idempotent no-op (FR-010).
   *
   * ⚠️ A restricted field the caller cannot see gets the SAME refusal an unknown key gets —
   * `not_found` — so a write cannot be used as an existence oracle (FR-016).
   */
  async setFieldValue(
    accountId: string,
    conversationId: string,
    fieldKey: string,
    rawValue: string,
    clear: boolean,
    actor: ClassificationActor,
    canSeeRestricted: boolean,
  ): Promise<{ changed: boolean }> {
    const db = this.prisma.forAccount(accountId);
    const convo = (await db.conversation.findFirst({
      where: { id: conversationId },
      select: {
        id: true,
        brand_id: true,
        form_key: true,
        sub_category: true,
        shelved_state: true,
      },
    })) as {
      id: string;
      brand_id: string;
      form_key: string | null;
      sub_category: string | null;
      shelved_state: string | null;
    } | null;
    if (!convo) throw new FieldsRefusal('not_found', 'not found');
    if (convo.shelved_state) throw new FieldsRefusal('precondition', 'conversation is shelved');

    const field = await this.fieldByKey(accountId, fieldKey);
    if (!field || !field.active || (field.restricted && !canSeeRestricted)) {
      throw new FieldsRefusal('not_found', 'unknown field');
    }
    if (!convo.form_key) {
      throw new FieldsRefusal('precondition', 'the conversation has no form');
    }
    const form = await this.formByKey(accountId, convo.form_key);
    if (!form) throw new FieldsRefusal('precondition', 'the conversation has no form');
    const entries = (await db.formField.findMany({
      where: { form_id: form.id },
      select: ENTRY_SELECT,
    })) as EntryRow[];
    const entry = entries.find((e) => e.field_id === field.id);
    if (!entry) {
      throw new FieldsRefusal('precondition', "the field is not on this conversation's form");
    }
    if (field.brand_ids.length && !field.brand_ids.includes(convo.brand_id)) {
      throw new FieldsRefusal('precondition', "the field does not apply to this conversation's brand");
    }

    const valueRows = (await db.conversationFieldValue.findMany({
      where: { conversation_id: conversationId },
      select: { field_id: true, value: true },
    })) as Array<{ field_id: string; value: string }>;
    const valueOfEntry = (e: EntryRow): string | null =>
      e.is_subcategory_source
        ? convo.sub_category
        : (valueRows.find((v) => v.field_id === e.field_id)?.value ?? null);

    if (entry.condition_field_id) {
      const parent = entries.find((e) => e.field_id === entry.condition_field_id);
      const parentValue = parent ? valueOfEntry(parent) : null;
      if (!parent || parentValue !== entry.condition_value) {
        throw new FieldsRefusal('precondition', 'the field is hidden by its parent choice');
      }
    }

    let value = '';
    if (!clear) {
      value = rawValue.trim();
      if (!value) throw new FieldsRefusal('invalid', 'a value is required (use clear to empty)');
      if (value.length > MAX_VALUE) throw new FieldsRefusal('invalid', 'value too long');
      if (field.type === 'numeric' && !isNumericFieldValue(value)) {
        throw new FieldsRefusal('invalid', 'the value must be a number');
      }
      if (FIELD_TYPES[field.type as FieldType].hasOptions) {
        const option = await db.optionValue.findFirst({
          where: { option_set_id: field.option_set_id!, value, active: true },
          select: { id: true },
        });
        if (!option) {
          throw new FieldsRefusal('invalid', "the value is not in the field's option set");
        }
      }
    }

    const current = valueOfEntry(entry);
    const next = clear ? null : value;
    if (current === next) return { changed: false };

    const statements: unknown[] = [];
    if (entry.is_subcategory_source) {
      statements.push(
        db.conversation.updateMany({
          where: { id: conversationId, ...classificationLock(actor) },
          data: { sub_category: next, classified_by: classifiedByOf(actor) },
        }),
      );
    } else if (next === null) {
      statements.push(
        db.conversationFieldValue.deleteMany({
          where: { conversation_id: conversationId, field_id: field.id },
        }),
      );
    } else {
      statements.push(
        db.conversationFieldValue.upsert({
          where: {
            conversation_id_field_id: { conversation_id: conversationId, field_id: field.id },
          },
          create: {
            account_id: accountId,
            conversation_id: conversationId,
            field_id: field.id,
            value: next,
          },
          update: { value: next },
        }),
      );
    }

    // The cascade: every dependent whose condition no longer holds loses its value, and ITS
    // dependents follow — computed breadth-first from the same reads the validation used.
    const doomed: EntryRow[] = [];
    const collect = (parentFieldId: string, parentValue: string | null) => {
      for (const child of entries.filter((e) => e.condition_field_id === parentFieldId)) {
        if (child.condition_value === parentValue) continue; // still unlocked — keeps its value
        if (valueOfEntry(child) === null && !doomed.includes(child)) {
          // No value to clear, but its children may still hold stale ones.
          collect(child.field_id, null);
          continue;
        }
        if (!doomed.includes(child)) {
          doomed.push(child);
          collect(child.field_id, null);
        }
      }
    };
    collect(entry.field_id, next);
    for (const d of doomed) {
      if (d.is_subcategory_source) {
        statements.push(
          db.conversation.updateMany({
            where: { id: conversationId, ...classificationLock(actor) },
            data: { sub_category: null, classified_by: classifiedByOf(actor) },
          }),
        );
      } else {
        statements.push(
          db.conversationFieldValue.deleteMany({
            where: { conversation_id: conversationId, field_id: d.field_id },
          }),
        );
      }
    }

    await db.$transaction(statements as never);
    return { changed: true };
  }

  // ── the solve gate (consumed by the status write path — spec FR-011) ──────────────────────────

  /**
   * The required, currently-VISIBLE-to-this-actor fields of the conversation's form that hold no
   * value — the keys a solved-category transition must name in its refusal. Empty for a formless
   * conversation: no form, no gate.
   */
  async missingRequiredForSolve(
    accountId: string,
    conversationId: string,
    canSeeRestricted: boolean,
  ): Promise<string[]> {
    const db = this.prisma.forAccount(accountId);
    const convo = (await db.conversation.findFirst({
      where: { id: conversationId },
      select: { brand_id: true, form_key: true, sub_category: true },
    })) as { brand_id: string; form_key: string | null; sub_category: string | null } | null;
    if (!convo?.form_key) return [];
    const form = await this.formByKey(accountId, convo.form_key);
    if (!form) return [];

    const entries = (await db.formField.findMany({
      where: { form_id: form.id },
      select: ENTRY_SELECT,
    })) as EntryRow[];
    const fields = (await db.fieldDefinition.findMany({
      where: { id: { in: entries.map((e) => e.field_id) } },
      select: FIELD_SELECT,
    })) as FieldRow[];
    const fieldById = new Map(fields.map((f) => [f.id, f]));
    const valueRows = (await db.conversationFieldValue.findMany({
      where: { conversation_id: conversationId },
      select: { field_id: true, value: true },
    })) as Array<{ field_id: string; value: string }>;
    const valueOfEntry = (e: EntryRow): string | null =>
      e.is_subcategory_source
        ? convo.sub_category
        : (valueRows.find((v) => v.field_id === e.field_id)?.value ?? null);

    const missing: string[] = [];
    for (const e of entries) {
      const f = fieldById.get(e.field_id);
      if (!f || !f.active || !f.required) continue;
      if (f.restricted && !canSeeRestricted) continue; // invisible must not gate (spec edge case)
      if (f.brand_ids.length && !f.brand_ids.includes(convo.brand_id)) continue;
      if (e.condition_field_id) {
        const parent = entries.find((p) => p.field_id === e.condition_field_id);
        if (!parent || valueOfEntry(parent) !== e.condition_value) continue; // hidden — not gating
      }
      if (valueOfEntry(e) === null) missing.push(f.key);
    }
    return missing;
  }
}

// ── wire converters (absent optionals become empty strings — the repo convention) ───────────────

export function toFieldDefWire(f: FieldRow) {
  return {
    id: f.id,
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required,
    restricted: f.restricted,
    optionSetId: f.option_set_id ?? '',
    brandIds: f.brand_ids,
    active: f.active,
  };
}

export function toFormWire(
  form: FormRow,
  entries: EntryRow[],
  fieldKeyById: Map<string, string>,
) {
  return {
    id: form.id,
    key: form.key,
    name: form.name,
    category: form.category ?? '',
    active: form.active,
    order: form.order,
    entries: entries.map((e) => ({
      fieldKey: fieldKeyById.get(e.field_id) ?? '',
      order: e.order,
      conditionFieldKey: e.condition_field_id
        ? (fieldKeyById.get(e.condition_field_id) ?? '')
        : '',
      conditionValue: e.condition_value ?? '',
      isSubcategorySource: e.is_subcategory_source,
    })),
  };
}
