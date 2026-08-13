import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { ConversationRepository } from '../conversation/conversation.repository';
import { LabelsRepository, type LabelRow } from './labels.repository';

interface ConversationIdRequestWire {
  conversationId?: string;
}
interface LabelLinkRequestWire {
  conversationId?: string;
  labelId?: string;
}
interface CreateLabelRequestWire {
  name?: string;
  color?: string;
}

const toLabelWire = (l: LabelRow) => ({ id: l.id, name: l.name, color: l.color ?? '' });

/**
 * Labels (feature 013, US2 — roadmap 4.5). Gated by `crm.labels.manage` at this tier and at the
 * gateway (Principle II). Reads and writes are account-scoped; every conversation-targeting
 * operation is brand resource-checked first, so a foreign-brand id is indistinguishable from a
 * missing one.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class LabelsController {
  constructor(
    @Inject(LabelsRepository) private readonly labels: LabelsRepository,
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
  ) {}

  /** Resource-check a conversation and return its account id, or throw NOT_FOUND. */
  private async assertConversation(metadata: Metadata, conversationId?: string) {
    const ctx = readActorContext(metadata);
    const id = (conversationId ?? '').trim();
    if (!id) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'conversation_id is required',
      });
    }
    const existing = await this.conversations.getById(ctx.accountId, id);
    if (!existing) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }
    return { ctx, id };
  }

  @GrpcMethod('ChatsReadService', 'ListLabels')
  @RequiresChatsPermission('crm.labels.manage')
  async listLabels(_req: unknown, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const rows = await this.labels.list(ctx.accountId);
    return { labels: rows.map(toLabelWire) };
  }

  /**
   * ⭐ W16 (subpoint 3.11) — the registry: every label with its usage count. The same key as the
   * list above: the registry is the label vocabulary enriched with an aggregate, not a new fact
   * class, and a second key would be one nobody remembers to grant. A SEPARATE rpc rather than a
   * field on ListLabels: the pickers read that one constantly and must not pay for the count.
   */
  @GrpcMethod('ChatsReadService', 'ListLabelUsage')
  @RequiresChatsPermission('crm.labels.manage')
  async listLabelUsage(_req: unknown, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const rows = await this.labels.listWithUsage(ctx.accountId);
    return { labels: rows.map((l) => ({ ...toLabelWire(l), usageCount: l.usageCount })) };
  }

  @GrpcMethod('ChatsReadService', 'ListConversationLabels')
  @RequiresChatsPermission('crm.labels.manage')
  async listConversationLabels(req: ConversationIdRequestWire, metadata: Metadata) {
    const { ctx, id } = await this.assertConversation(metadata, req.conversationId);
    const rows = await this.labels.listForConversation(ctx.accountId, id);
    return { labels: rows.map(toLabelWire) };
  }

  @GrpcMethod('ChatsWriteService', 'CreateLabel')
  @RequiresChatsPermission('crm.labels.manage')
  async createLabel(req: CreateLabelRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const name = (req.name ?? '').trim();
    if (!name) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'name is required' });
    }
    try {
      const row = await this.labels.create(ctx.accountId, name, (req.color ?? '').trim() || null);
      return toLabelWire(row);
    } catch {
      // The account+name unique constraint (feature 006) means a duplicate CONFLICTS rather than
      // creating a second label with the same name (spec Edge Case).
      throw new RpcException({
        code: GrpcStatus.ALREADY_EXISTS,
        message: 'label name already used',
      });
    }
  }

  @GrpcMethod('ChatsWriteService', 'AttachLabel')
  @RequiresChatsPermission('crm.labels.manage')
  async attachLabel(req: LabelLinkRequestWire, metadata: Metadata) {
    const { ctx, id } = await this.assertConversation(metadata, req.conversationId);
    const labelId = (req.labelId ?? '').trim();
    // A label from another account must never become attachable — the scoped lookup makes it
    // unresolvable, and we answer NOT_FOUND rather than disclosing that it exists elsewhere.
    if (!labelId || !(await this.labels.exists(ctx.accountId, labelId))) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }
    await this.labels.attach(ctx.accountId, id, labelId);
    return { ok: true };
  }

  @GrpcMethod('ChatsWriteService', 'DetachLabel')
  @RequiresChatsPermission('crm.labels.manage')
  async detachLabel(req: LabelLinkRequestWire, metadata: Metadata) {
    const { ctx, id } = await this.assertConversation(metadata, req.conversationId);
    const labelId = (req.labelId ?? '').trim();
    if (!labelId) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'label_id is required' });
    }
    // Detaching a link that isn't there is a no-op, not an error (SC-006).
    await this.labels.detach(ctx.accountId, id, labelId);
    return { ok: true };
  }
}
