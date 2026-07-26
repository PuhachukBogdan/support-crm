import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext, mayAccessBrand } from '../security/actor-context';
import { toDetailWire, wireToStatus, isValidStatusWire } from '../shared/wire';
import { DomainEventPublisher } from '../events/events.publisher';
import { ConversationRepository } from './conversation.repository';

interface CreateConversationRequestWire {
  brandId: string;
  playerId?: string;
  priority?: string;
  channel?: string;
  assigneeOperatorId?: string;
}
interface SetConversationStatusRequestWire {
  conversationId: string;
  status?: string;
}

/**
 * ChatsWriteService — conversation writes (feature 012, US1). `CreateConversation` seeds/tests +
 * future channel ingress; `SetConversationStatus` is the 4.1 lifecycle change. Gated by
 * `crm.conversation.reply` at both tiers; account scope via `forAccount`; brand resource-checked (R3).
 *
 * Feature 014 publishes `conversation.created` and `conversation.status_changed` from here. Publishing
 * sits at the controller and nowhere else, so an automation's own status write emits nothing and
 * cannot cascade (FR-006 / research R4) — a self-satisfying rule is bounded by construction.
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class ConversationWriteController {
  constructor(
    @Inject(ConversationRepository) private readonly repo: ConversationRepository,
    @Inject(DomainEventPublisher) private readonly events: DomainEventPublisher,
  ) {}

  @GrpcMethod('ChatsWriteService', 'CreateConversation')
  @RequiresChatsPermission('crm.conversation.reply')
  async createConversation(req: CreateConversationRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    if (!req.brandId || !mayAccessBrand(ctx, req.brandId)) {
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    const row = await this.repo.create(ctx.accountId, {
      brandId: req.brandId,
      playerId: req.playerId || undefined,
      priority: req.priority || undefined,
      channel: req.channel || undefined,
      assigneeOperatorId: req.assigneeOperatorId || undefined,
    });
    await this.events.conversationCreated(ctx.accountId, row.id);
    // Re-read: a rule may have changed status/priority/assignee, and the caller should see the
    // conversation as it actually is now rather than as it was a moment before the rules ran.
    const fresh = await this.repo.getById(ctx.accountId, row.id);
    return toDetailWire(fresh ?? row);
  }

  @GrpcMethod('ChatsWriteService', 'SetConversationStatus')
  @RequiresChatsPermission('crm.conversation.reply')
  async setConversationStatus(req: SetConversationStatusRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    if (!isValidStatusWire(req.status)) {
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid status' });
    }
    // Resource-check the target's brand before mutating (no existence disclosure otherwise).
    const existing = await this.repo.getById(ctx.accountId, req.conversationId);
    if (!existing || !mayAccessBrand(ctx, existing.brand_id)) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }
    const newStatus = wireToStatus(req.status)!;
    const updated = await this.repo.setStatus(ctx.accountId, req.conversationId, newStatus);
    if (!updated) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    await this.events.statusChanged(
      ctx.accountId,
      req.conversationId,
      newStatus,
      updated.updated_at,
    );
    const fresh = await this.repo.getById(ctx.accountId, req.conversationId);
    return toDetailWire(fresh ?? updated);
  }
}
