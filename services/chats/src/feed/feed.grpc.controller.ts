import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext, resolveBrandIn } from '../security/actor-context';
import { clampPageSize, decodeCursor, encodeCursor, InvalidCursorError } from '../shared/cursor';
import { toSummaryWire } from '../shared/wire';
import { ConversationRepository } from '../conversation/conversation.repository';

interface GetPlayerFeedRequestWire {
  playerId: string;
  projection?: string;
  pageToken?: string;
  pageSize?: number;
}

/**
 * ChatsReadService.GetPlayerFeed (feature 012, US3). One chronological feed of a player's
 * conversations keyed by `player_id`, merged across the brands the player spans WITHIN the account
 * (brand-union) — never across accounts (Principle I, `forAccount`). Reuses the US1 conversation
 * list (a feed is a player-filtered list) intersected with the caller's permitted brands (R3), so
 * a brand the agent may not serve is omitted. The feed returns conversation summaries (no message
 * bodies), so no private-note content is exposed here by construction (SEC-13 stays a thread concern).
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class FeedReadController {
  constructor(@Inject(ConversationRepository) private readonly repo: ConversationRepository) {}

  @GrpcMethod('ChatsReadService', 'GetPlayerFeed')
  @RequiresChatsPermission('crm.inbox.view')
  async getPlayerFeed(req: GetPlayerFeedRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    // Unknown / empty player → empty feed (never an error that could disclose cross-account existence).
    if (!req.playerId) return { conversations: [], nextPageToken: '' };

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
      playerId: req.playerId,
      brandIn: resolveBrandIn(ctx, undefined), // all permitted brands → brand-union within account
      limit: clampPageSize(req.pageSize),
      cursor,
    });
    return {
      conversations: rows.map(toSummaryWire),
      nextPageToken: nextCursor ? encodeCursor(nextCursor) : '',
    };
  }
}
