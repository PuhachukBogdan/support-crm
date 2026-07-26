import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext, mayAccessBrand } from '../security/actor-context';
import { toDetailWire } from '../shared/wire';
import { ConversationRepository } from '../conversation/conversation.repository';
import { RoundRobinStateRepository } from './round-robin-state.repository';
import type { RoundRobinCandidate } from './round-robin';

interface AutoAssignRequestWire {
  conversationId?: string;
  groupKey?: string;
  candidates?: { operatorId?: string; capacity?: number; currentLoad?: number }[];
}

/** Machine-readable reasons for a non-assignment (spec US3 #3/#4). */
export const NO_OPERATOR_AVAILABLE = 'NO_OPERATOR_AVAILABLE';
export const GROUP_ROUTING_NOT_AVAILABLE = 'GROUP_ROUTING_NOT_AVAILABLE';

/**
 * ChatsWriteService — round-robin auto-assignment (feature 013, US3 / roadmap 4.4). Same permission
 * as manual assignment (`crm.conversation.assign`) at both tiers.
 *
 * The candidate set is **supplied by the caller** until the Users service can resolve teams and
 * capacity (roadmap 5.3 / research R3): this handler makes no Users call. When no candidate set is
 * supplied, it answers `GROUP_ROUTING_NOT_AVAILABLE` rather than guessing a group — the spec is
 * explicit that a guess is worse than an honest "not yet" (US3 #4).
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class AutoAssignController {
  constructor(
    @Inject(RoundRobinStateRepository) private readonly rotation: RoundRobinStateRepository,
    @Inject(ConversationRepository) private readonly conversations: ConversationRepository,
  ) {}

  @GrpcMethod('ChatsWriteService', 'AutoAssignConversation')
  @RequiresChatsPermission('crm.conversation.assign')
  async autoAssignConversation(req: AutoAssignRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const conversationId = (req.conversationId ?? '').trim();
    if (!conversationId) {
      throw new RpcException({
        code: GrpcStatus.INVALID_ARGUMENT,
        message: 'conversation_id is required',
      });
    }

    // Resource-check the target before anything else (no existence disclosure).
    const conversation = await this.conversations.getById(ctx.accountId, conversationId);
    if (!conversation || !mayAccessBrand(ctx, conversation.brand_id)) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }

    const candidates: RoundRobinCandidate[] = (req.candidates ?? [])
      .map((c) => ({
        operatorId: (c?.operatorId ?? '').trim(),
        capacity: Number(c?.capacity ?? 0),
        currentLoad: Number(c?.currentLoad ?? 0),
      }))
      .filter((c) => c.operatorId !== '');

    // No candidate set → group membership is not resolvable yet (Phase 5). Say so; don't guess.
    if (candidates.length === 0) {
      return {
        assigned: false,
        operatorId: '',
        reason: GROUP_ROUTING_NOT_AVAILABLE,
      };
    }

    const groupKey = (req.groupKey ?? '').trim() || 'default';
    const { operatorId } = await this.rotation.selectAndAssign(
      ctx.accountId,
      conversationId,
      groupKey,
      candidates,
    );

    // Everyone at capacity: the conversation stays as it was — never assigned to an over-capacity
    // operator just to have an answer (spec US3 #3).
    if (operatorId === null) {
      return { assigned: false, operatorId: '', reason: NO_OPERATOR_AVAILABLE };
    }

    const updated = await this.conversations.getById(ctx.accountId, conversationId);
    return {
      assigned: true,
      operatorId,
      reason: '',
      ...(updated ? { conversation: toDetailWire(updated) } : {}),
    };
  }
}
