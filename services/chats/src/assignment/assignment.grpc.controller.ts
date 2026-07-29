import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext } from '../security/actor-context';
import { toDetailWire } from '../shared/wire';
import { ConversationRepository } from '../conversation/conversation.repository';
import { AssignmentRepository } from './assignment.repository';

interface AssignConversationRequestWire {
  conversationId?: string;
  operatorId?: string;
}

/**
 * ChatsWriteService — assignment (feature 013, US1 / roadmap 4.4). Gated by
 * `crm.conversation.assign` at this tier **and** at the gateway (Principle II, deny-by-default).
 * The target conversation is brand resource-checked before any write, so a foreign-brand or
 * other-account id is indistinguishable from a nonexistent one (no existence disclosure).
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class AssignmentWriteController {
  constructor(
    @Inject(AssignmentRepository) private readonly assignments: AssignmentRepository,
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
  ) {}

  @GrpcMethod('ChatsWriteService', 'AssignConversation')
  @RequiresChatsPermission('crm.conversation.assign')
  async assignConversation(req: AssignConversationRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const conversationId = (req.conversationId ?? '').trim();
    if (!conversationId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'conversation_id is required',
      });
    }

    // Resource-check the target's brand BEFORE mutating (same rule as 012's status write).
    const existing = await this.conversations.getById(ctx.accountId, conversationId);
    if (!existing) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }

    // "" means unassign — store NULL, never an empty string (it would look like an operator id).
    const operatorId = (req.operatorId ?? '').trim() || null;
    const updated = await this.assignments.setAssignee(ctx.accountId, conversationId, operatorId);
    if (!updated) throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    return toDetailWire(updated);
  }
}
