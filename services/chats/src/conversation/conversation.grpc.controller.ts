import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod } from '@nestjs/microservices';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext, resolveBrandIn, mayAccessBrand } from '../security/actor-context';
import { clampPageSize, decodeCursor, encodeCursor, InvalidCursorError } from '../shared/cursor';
import { toSummaryWire, toDetailWire, wireToStatus } from '../shared/wire';
import { ConversationRepository } from './conversation.repository';

// proto-loader (keepCase:false) delivers camelCase request objects.
interface ListConversationsRequestWire {
  status?: string;
  priority?: string;
  assigneeOperatorId?: string;
  playerId?: string;
  brandId?: string;
  pageToken?: string;
  pageSize?: number;
}
interface GetConversationRequestWire {
  id: string;
}

/**
 * ChatsReadService — conversation reads (feature 012, US1). Gated at BOTH tiers: the gateway
 * `@RequiresPermission` + this service-tier `ChatsAccessGuard` (Principle II / SC-004). Account +
 * brand scope come from the gateway-set metadata (`x-actor-*`); list is confined to the account
 * (Principle I) and intersected with the caller's permitted brands (R3). Keyset paging (R7).
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class ConversationReadController {
  constructor(@Inject(ConversationRepository) private readonly repo: ConversationRepository) {}

  @GrpcMethod('ChatsReadService', 'ListConversations')
  @RequiresChatsPermission('crm.inbox.view')
  async listConversations(req: ListConversationsRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    let cursor;
    try {
      cursor = decodeCursor(req.pageToken);
    } catch (e) {
      if (e instanceof InvalidCursorError) {
        throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid page token' });
      }
      throw e;
    }
    const { rows, nextCursor } = await this.repo.list(ctx.accountId, {
      status: wireToStatus(req.status),
      priority: req.priority || undefined,
      assigneeOperatorId: req.assigneeOperatorId || undefined,
      playerId: req.playerId || undefined,
      brandIn: resolveBrandIn(ctx, req.brandId),
      limit: clampPageSize(req.pageSize),
      cursor,
    });
    return {
      conversations: rows.map(toSummaryWire),
      nextPageToken: nextCursor ? encodeCursor(nextCursor) : '',
    };
  }

  @GrpcMethod('ChatsReadService', 'GetConversation')
  @RequiresChatsPermission('crm.inbox.view')
  async getConversation(req: GetConversationRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const row = await this.repo.getById(ctx.accountId, req.id);
    // Not in this account, or a brand the caller may not serve → identical NOT_FOUND (no existence
    // disclosure across tenants — spec Edge Cases).
    if (!row || !mayAccessBrand(ctx, row.brand_id)) {
      throw new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });
    }
    return toDetailWire(row);
  }
}
