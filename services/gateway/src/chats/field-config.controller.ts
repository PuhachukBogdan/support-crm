import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { type Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { CHATS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { buildActorMetadata } from './actor-metadata';
import { callChats } from './rpc';

interface FieldDefWire {
  key: string;
}
interface OptionSetWire {
  id: string;
}
interface FormWire {
  key: string;
}
interface ChatsReadGrpc {
  getFieldConfiguration(d: Record<string, unknown>, md?: unknown): Observable<unknown>;
  getConversationFieldView(d: Record<string, unknown>, md?: unknown): Observable<unknown>;
}
interface ChatsWriteGrpc {
  upsertFieldDefinition(d: Record<string, unknown>, md?: unknown): Observable<FieldDefWire>;
  upsertOptionSet(d: Record<string, unknown>, md?: unknown): Observable<OptionSetWire>;
  deleteOptionSet(d: { id: string }, md?: unknown): Observable<unknown>;
  upsertForm(d: Record<string, unknown>, md?: unknown): Observable<FormWire>;
  setConversationForm(d: Record<string, unknown>, md?: unknown): Observable<unknown>;
  setConversationFieldValue(d: Record<string, unknown>, md?: unknown): Observable<unknown>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

interface FieldBody {
  label?: string;
  type?: string;
  required?: boolean;
  restricted?: boolean;
  optionSetId?: string;
  brandIds?: string[];
  active?: boolean;
}
interface OptionSetBody {
  name?: string;
  values?: { value?: string; order?: number; active?: boolean }[];
}
interface FormBody {
  name?: string;
  category?: string;
  active?: boolean;
  order?: number;
  entries?: {
    fieldKey?: string;
    order?: number;
    conditionFieldKey?: string;
    conditionValue?: string;
    isSubcategorySource?: boolean;
  }[];
}

const strings = (xs: unknown): string[] =>
  Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string') : [];

/** SHAPE-mapping only (no dictionary knowledge — that lives in chats, the SetPriority rule). */
const fieldWire = (key: string, b: FieldBody) => ({
  key,
  label: typeof b?.label === 'string' ? b.label : '',
  type: typeof b?.type === 'string' ? b.type : '',
  required: b?.required === true,
  restricted: b?.restricted === true,
  optionSetId: typeof b?.optionSetId === 'string' ? b.optionSetId : '',
  brandIds: strings(b?.brandIds),
  active: b?.active !== false,
});

const optionSetWire = (id: string, b: OptionSetBody) => ({
  id,
  name: typeof b?.name === 'string' ? b.name : '',
  values: Array.isArray(b?.values)
    ? b.values.map((v, i) => ({
        value: typeof v?.value === 'string' ? v.value : '',
        order: typeof v?.order === 'number' ? v.order : i,
        active: v?.active !== false,
      }))
    : [],
  // proto3 cannot tell an absent list from an empty one, so the EDGE states which this was: a
  // rename-only PATCH must not read as "all values disappeared" (criterion ① — found in review).
  replaceValues: Array.isArray(b?.values),
});

const formWire = (key: string, b: FormBody) => ({
  key,
  name: typeof b?.name === 'string' ? b.name : '',
  category: typeof b?.category === 'string' ? b.category : '',
  active: b?.active !== false,
  order: typeof b?.order === 'number' ? b.order : 0,
  entries: Array.isArray(b?.entries)
    ? b.entries.map((e, i) => ({
        fieldKey: typeof e?.fieldKey === 'string' ? e.fieldKey : '',
        order: typeof e?.order === 'number' ? e.order : i,
        conditionFieldKey: typeof e?.conditionFieldKey === 'string' ? e.conditionFieldKey : '',
        conditionValue: typeof e?.conditionValue === 'string' ? e.conditionValue : '',
        isSubcategorySource: e?.isSubcategorySource === true,
      }))
    : [],
  // The `replaceValues` reasoning, second instance: an archive/rename PATCH that omitted `entries`
  // must not wipe a form's composition.
  replaceEntries: Array.isArray(b?.entries),
});

/**
 * ⭐ Feature 037 (roadmap 4.15 — W30) — the fields/forms REST edge.
 *
 * Authoring rides `platform.field.manage` (one key for one configuration scope); the two ticket
 * writes ride `crm.conversation.reply` (the SetPriority reasoning); the per-conversation view rides
 * the inbox read it accompanies. The edge does SHAPE checks only — the type vocabulary, option-set
 * membership, brand applicability, conditions and the U9 lock all validate in chats, where the
 * data lives. The W15a translation applies: POST creates (the key derives from the label/name in
 * the service), PATCH-by-key edits. ⚠️ A PATCH carries the FULL row: fields re-send label/type
 * (the service validates them every time), and a present `values`/`entries` array IS the
 * composition — the edge marks that with `replace_values`/`replace_entries`, so an archive or
 * rename PATCH that omitted the array cannot silently wipe what is stored (criterion ① — found in
 * the block's own review pass).
 */
@Controller()
export class FieldConfigController implements OnModuleInit {
  private read!: ChatsReadGrpc;
  private write!: ChatsWriteGrpc;

  constructor(@Inject(CHATS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.read = this.client.getService<ChatsReadGrpc>('ChatsReadService');
    this.write = this.client.getService<ChatsWriteGrpc>('ChatsWriteService');
  }

  private meta(req: ChatsReq) {
    return buildActorMetadata(req.claims!, req.effective);
  }

  // ── authoring ──────────────────────────────────────────────────────────────────────────────────

  @Get('admin/field-config')
  @RequiresPermission('platform.field.manage')
  async configuration(@Req() req: ChatsReq) {
    return callChats(this.read.getFieldConfiguration({}, this.meta(req)));
  }

  @Post('admin/field-config/fields')
  @RequiresPermission('platform.field.manage')
  async createField(@Body() body: FieldBody, @Req() req: ChatsReq) {
    return callChats(this.write.upsertFieldDefinition(fieldWire('', body), this.meta(req)));
  }

  @Patch('admin/field-config/fields/:key')
  @RequiresPermission('platform.field.manage')
  async updateField(@Param('key') key: string, @Body() body: FieldBody, @Req() req: ChatsReq) {
    return callChats(this.write.upsertFieldDefinition(fieldWire(key, body), this.meta(req)));
  }

  @Post('admin/field-config/option-sets')
  @RequiresPermission('platform.field.manage')
  async createOptionSet(@Body() body: OptionSetBody, @Req() req: ChatsReq) {
    return callChats(this.write.upsertOptionSet(optionSetWire('', body), this.meta(req)));
  }

  @Patch('admin/field-config/option-sets/:id')
  @RequiresPermission('platform.field.manage')
  async updateOptionSet(@Param('id') id: string, @Body() body: OptionSetBody, @Req() req: ChatsReq) {
    return callChats(this.write.upsertOptionSet(optionSetWire(id, body), this.meta(req)));
  }

  @Delete('admin/field-config/option-sets/:id')
  @RequiresPermission('platform.field.manage')
  async deleteOptionSet(@Param('id') id: string, @Req() req: ChatsReq) {
    return callChats(this.write.deleteOptionSet({ id }, this.meta(req)));
  }

  @Post('admin/field-config/forms')
  @RequiresPermission('platform.field.manage')
  async createForm(@Body() body: FormBody, @Req() req: ChatsReq) {
    return callChats(this.write.upsertForm(formWire('', body), this.meta(req)));
  }

  @Patch('admin/field-config/forms/:key')
  @RequiresPermission('platform.field.manage')
  async updateForm(@Param('key') key: string, @Body() body: FormBody, @Req() req: ChatsReq) {
    return callChats(this.write.upsertForm(formWire(key, body), this.meta(req)));
  }

  // ── the ticket window ──────────────────────────────────────────────────────────────────────────

  @Get('conversations/:id/fields')
  @RequiresPermission('crm.inbox.view')
  async conversationFieldView(@Param('id') id: string, @Req() req: ChatsReq) {
    return callChats(this.read.getConversationFieldView({ conversationId: id }, this.meta(req)));
  }

  @Patch('conversations/:id/form')
  @RequiresPermission('crm.conversation.reply')
  async setForm(@Param('id') id: string, @Body() body: { formKey?: string }, @Req() req: ChatsReq) {
    return callChats(
      this.write.setConversationForm(
        {
          conversationId: id,
          formKey: typeof body?.formKey === 'string' ? body.formKey : '',
        },
        this.meta(req),
      ),
    );
  }

  @Patch('conversations/:id/fields/:key')
  @RequiresPermission('crm.conversation.reply')
  async setFieldValue(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() body: { value?: string; clear?: boolean },
    @Req() req: ChatsReq,
  ) {
    return callChats(
      this.write.setConversationFieldValue(
        {
          conversationId: id,
          fieldKey: key,
          value: typeof body?.value === 'string' ? body.value : '',
          clear: body?.clear === true,
        },
        this.meta(req),
      ),
    );
  }
}
