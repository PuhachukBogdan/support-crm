import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { AuditRepository } from '../audit/audit.repository';
import {
  FieldsRepository,
  FieldsRefusal,
  toFieldDefWire,
  toFormWire,
  type OptionValueRow,
  type UpsertFormEntryInput,
} from './fields.repository';

interface OptionValueWire {
  value?: string;
  order?: number;
  active?: boolean;
}
interface UpsertFieldWire {
  key?: string;
  label?: string;
  type?: string;
  required?: boolean;
  restricted?: boolean;
  optionSetId?: string;
  brandIds?: string[];
  active?: boolean;
}
interface UpsertOptionSetWire {
  id?: string;
  name?: string;
  values?: OptionValueWire[];
  replaceValues?: boolean;
}
interface FormEntryWire {
  fieldKey?: string;
  order?: number;
  conditionFieldKey?: string;
  conditionValue?: string;
  isSubcategorySource?: boolean;
}
interface UpsertFormWire {
  key?: string;
  name?: string;
  category?: string;
  active?: boolean;
  order?: number;
  entries?: FormEntryWire[];
  replaceEntries?: boolean;
}

/** FieldsRefusal → the gRPC vocabulary. One mapping, so a new refusal cannot invent a code. */
function rethrow(e: unknown): never {
  if (e instanceof FieldsRefusal) {
    const code =
      e.kind === 'not_found'
        ? GrpcStatus.NOT_FOUND
        : e.kind === 'conflict'
          ? GrpcStatus.ALREADY_EXISTS
          : e.kind === 'precondition'
            ? GrpcStatus.FAILED_PRECONDITION
            : GrpcStatus.INVALID_ARGUMENT;
    throw new RpcException({ code, message: e.message });
  }
  throw e;
}

/**
 * ⭐ Feature 037 (roadmap 4.15 — W30) — the fields/forms/option-sets authoring surface.
 *
 * ── One key for one configuration scope ──────────────────────────────────────────────────────────
 * `platform.field.manage` at both tiers (the status-admin shape): shaping what agents record on
 * every ticket is one act whether it enters through a field, a set or a form. Every write is
 * audited (`field/option_set/form.config_changed`) inside its own transaction, target = the
 * per-account key (the trail references the row, it never copies it — no labels, no values).
 *
 * ── What is deliberately absent ──────────────────────────────────────────────────────────────────
 * DELETE for fields and forms (archive is `active: false` — values on conversations outlive every
 * authoring act, criterion ①), key editing (the identity conversations and value rows stand on),
 * and any per-value rpc (a set is authored as a unit; the repository diffs).
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class FieldsAdminController {
  constructor(
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(AuditRepository) private readonly audit: AuditRepository,
  ) {}

  @GrpcMethod('ChatsReadService', 'GetFieldConfiguration')
  @RequiresChatsPermission('platform.field.manage')
  async getFieldConfiguration(_req: unknown, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const cfg = await this.fields.configuration(ctx.accountId);
    const fieldKeyById = new Map(cfg.fields.map((f) => [f.id, f.key]));
    return {
      optionSets: cfg.sets.map((s) => ({
        id: s.id,
        name: s.name,
        values: cfg.values
          .filter((v) => v.option_set_id === s.id)
          .map((v) => ({ value: v.value, order: v.order, active: v.active })),
      })),
      fields: cfg.fields.map(toFieldDefWire),
      forms: cfg.forms.map((f) =>
        toFormWire(
          f,
          cfg.entries.filter((e) => e.form_id === f.id),
          fieldKeyById,
        ),
      ),
    };
  }

  @GrpcMethod('ChatsWriteService', 'UpsertFieldDefinition')
  @RequiresChatsPermission('platform.field.manage')
  async upsertFieldDefinition(req: UpsertFieldWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const key = (req.key ?? '').trim();
    const statement = this.audit.statement(ctx.accountId, {
      actorUserId: ctx.userId,
      actorKind: 'user',
      underPreview: ctx.underPreview,
      action: 'field.config_changed',
      // On create the key does not exist yet — the derived key is re-stated by the repository's
      // returned row; the trail's target is what the row is called either way.
      targetRef: key || 'created',
    });
    try {
      const row = await this.fields.upsertField(
        ctx.accountId,
        {
          key,
          label: req.label ?? '',
          type: (req.type ?? '').trim(),
          required: req.required === true,
          restricted: req.restricted === true,
          optionSetId: req.optionSetId ?? '',
          brandIds: Array.isArray(req.brandIds) ? req.brandIds : [],
          active: req.active !== false,
        },
        statement,
      );
      return toFieldDefWire(row);
    } catch (e) {
      rethrow(e);
    }
  }

  @GrpcMethod('ChatsWriteService', 'UpsertOptionSet')
  @RequiresChatsPermission('platform.field.manage')
  async upsertOptionSet(req: UpsertOptionSetWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const id = (req.id ?? '').trim();
    const statement = this.audit.statement(ctx.accountId, {
      actorUserId: ctx.userId,
      actorKind: 'user',
      underPreview: ctx.underPreview,
      action: 'option_set.config_changed',
      targetRef: id || 'created',
    });
    const values: OptionValueRow[] = (req.values ?? []).map((v, i) => ({
      value: v.value ?? '',
      order: typeof v.order === 'number' ? v.order : i,
      active: v.active !== false,
    }));
    try {
      const set = await this.fields.upsertOptionSet(
        ctx.accountId,
        // A CREATE's request IS its composition; an update replaces only when it said so.
        { id, name: req.name ?? '', values, replaceValues: !id || req.replaceValues === true },
        statement,
      );
      // Read back the stored set so the screen renders exactly what the diff kept.
      const cfg = await this.fields.configuration(ctx.accountId);
      return {
        id: set.id,
        name: set.name,
        values: cfg.values
          .filter((v) => v.option_set_id === set.id)
          .map((v) => ({ value: v.value, order: v.order, active: v.active })),
      };
    } catch (e) {
      rethrow(e);
    }
  }

  @GrpcMethod('ChatsWriteService', 'DeleteOptionSet')
  @RequiresChatsPermission('platform.field.manage')
  async deleteOptionSet(req: { id?: string }, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const id = (req.id ?? '').trim();
    if (!id) throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'id is required' });
    const statement = this.audit.statement(ctx.accountId, {
      actorUserId: ctx.userId,
      actorKind: 'user',
      underPreview: ctx.underPreview,
      action: 'option_set.config_changed',
      targetRef: id,
    });
    try {
      await this.fields.deleteOptionSet(ctx.accountId, id, statement);
    } catch (e) {
      rethrow(e);
    }
    return { ok: true };
  }

  @GrpcMethod('ChatsWriteService', 'UpsertForm')
  @RequiresChatsPermission('platform.field.manage')
  async upsertForm(req: UpsertFormWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const key = (req.key ?? '').trim();
    const statement = this.audit.statement(ctx.accountId, {
      actorUserId: ctx.userId,
      actorKind: 'user',
      underPreview: ctx.underPreview,
      action: 'form.config_changed',
      targetRef: key || 'created',
    });
    const entries: UpsertFormEntryInput[] = (req.entries ?? []).map((e, i) => ({
      fieldKey: e.fieldKey ?? '',
      order: typeof e.order === 'number' ? e.order : i,
      conditionFieldKey: e.conditionFieldKey ?? '',
      conditionValue: e.conditionValue ?? '',
      isSubcategorySource: e.isSubcategorySource === true,
    }));
    try {
      const row = await this.fields.upsertForm(
        ctx.accountId,
        {
          key,
          name: req.name ?? '',
          category: req.category ?? '',
          active: req.active !== false,
          order: typeof req.order === 'number' ? req.order : 0,
          entries,
          replaceEntries: req.replaceEntries === true,
        },
        statement,
      );
      const cfg = await this.fields.configuration(ctx.accountId);
      const fieldKeyById = new Map(cfg.fields.map((f) => [f.id, f.key]));
      return toFormWire(
        row,
        cfg.entries.filter((e) => e.form_id === row.id),
        fieldKeyById,
      );
    } catch (e) {
      rethrow(e);
    }
  }
}
