import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext, readActorPermissions } from '../security/actor-context';
import { RealtimePublisher } from '../realtime/realtime.publisher';
import { FieldsRepository, FieldsRefusal } from './fields.repository';

interface SetFormWire {
  conversationId?: string;
  formKey?: string;
}
interface SetFieldValueWire {
  conversationId?: string;
  fieldKey?: string;
  value?: string;
  clear?: boolean;
}

/** The same FieldsRefusal → gRPC mapping the admin controller uses. */
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

/** Does THIS caller see restricted fields? Read per call — clearance is the caller's, not the route's. */
function clearanceOf(metadata: Metadata): boolean {
  return readActorPermissions(metadata).includes('crm.conversation.restricted_field.view');
}

/**
 * ⭐ Feature 037 (roadmap 4.15 — W30) — the ticket window's side of custom fields.
 *
 * ── The read is per-conversation and per-CALLER ──────────────────────────────────────────────────
 * `GetConversationFieldView` resolves the form's entries against the conversation's brand and the
 * caller's clearance: a restricted field is ABSENT from the payload for a caller without
 * `crm.conversation.restricted_field.view` — never blanked, never disabled (spec US3). Gated
 * `crm.inbox.view` like the detail read it accompanies.
 *
 * ── The writes reuse `crm.conversation.reply` ────────────────────────────────────────────────────
 * The SetPriority reasoning verbatim: working this conversation is already that key's authority,
 * and a key that gates one field is a key nobody assigns. The restricted write path still refuses
 * per caller — with the unknown-key refusal, so the key's absence is not an oracle (FR-016).
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class FieldsController {
  constructor(
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(RealtimePublisher) private readonly realtime: RealtimePublisher,
  ) {}

  @GrpcMethod('ChatsReadService', 'GetConversationFieldView')
  @RequiresChatsPermission('crm.inbox.view')
  async getConversationFieldView(req: { conversationId?: string }, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const conversationId = (req.conversationId ?? '').trim();
    if (!conversationId) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'conversationId is required' });
    }
    const view = await this.fields.conversationFieldView(
      ctx.accountId,
      conversationId,
      clearanceOf(metadata),
    );
    if (!view) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    return view;
  }

  @GrpcMethod('ChatsWriteService', 'SetConversationForm')
  @RequiresChatsPermission('crm.conversation.reply')
  async setConversationForm(req: SetFormWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const conversationId = (req.conversationId ?? '').trim();
    if (!conversationId) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'conversationId is required' });
    }
    try {
      const res = await this.fields.setConversationForm(
        ctx.accountId,
        conversationId,
        (req.formKey ?? '').trim(),
        { kind: 'user', ref: ctx.userId },
      );
      // An idempotent no-op publishes nothing: the second identical click must not fan out a
      // second event (FR-010) — the same-value rule every property write here follows.
      if (res.changed) {
        await this.realtime.conversation('conversation.updated', ctx.accountId, conversationId);
      }
    } catch (e) {
      rethrow(e);
    }
    return { ok: true };
  }

  @GrpcMethod('ChatsWriteService', 'SetConversationFieldValue')
  @RequiresChatsPermission('crm.conversation.reply')
  async setConversationFieldValue(req: SetFieldValueWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const conversationId = (req.conversationId ?? '').trim();
    const fieldKey = (req.fieldKey ?? '').trim();
    if (!conversationId || !fieldKey) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'conversationId and fieldKey are required',
      });
    }
    try {
      const res = await this.fields.setFieldValue(
        ctx.accountId,
        conversationId,
        fieldKey,
        req.value ?? '',
        req.clear === true,
        { kind: 'user', ref: ctx.userId },
        clearanceOf(metadata),
      );
      if (res.changed) {
        await this.realtime.conversation('conversation.updated', ctx.accountId, conversationId);
      }
    } catch (e) {
      rethrow(e);
    }
    return { ok: true };
  }
}
