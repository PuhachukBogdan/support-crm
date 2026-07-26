import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext, mayAccessBrand, type ActorContext } from '../security/actor-context';
import { clampPageSize, decodeCursor, encodeCursor, InvalidCursorError } from '../shared/cursor';
import { toMessageWire, projectionFromWire } from '../shared/wire';
import { MessageRepository } from './message.repository';

interface GetThreadRequestWire {
  conversationId: string;
  projection?: string;
  pageToken?: string;
  pageSize?: number;
}
interface PostMessageRequestWire {
  conversationId: string;
  kind?: string;
  body?: string;
  mentions?: string[];
}
interface RecordIncomingRequestWire {
  conversationId: string;
  body?: string;
  authorId?: string;
}

const notFound = () => new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

/** Shared brand resource-check: the conversation must exist in-account AND be a permitted brand. */
async function assertConversationAccess(
  repo: MessageRepository,
  ctx: ActorContext,
  conversationId: string,
): Promise<void> {
  const brand = await repo.conversationBrand(ctx.accountId, conversationId);
  if (brand === null || !mayAccessBrand(ctx, brand)) throw notFound();
}

/** ChatsReadService.GetThread — STAFF (all kinds) vs CUSTOMER (private notes excluded, R4). */
@Controller()
@UseGuards(ChatsAccessGuard)
export class MessageReadController {
  constructor(@Inject(MessageRepository) private readonly repo: MessageRepository) {}

  @GrpcMethod('ChatsReadService', 'GetThread')
  @RequiresChatsPermission('crm.inbox.view')
  async getThread(req: GetThreadRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    await assertConversationAccess(this.repo, ctx, req.conversationId);
    let cursor;
    try {
      cursor = decodeCursor(req.pageToken);
    } catch (e) {
      if (e instanceof InvalidCursorError) {
        throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid page token' });
      }
      throw e;
    }
    const { rows, nextCursor } = await this.repo.thread(
      ctx.accountId,
      req.conversationId,
      projectionFromWire(req.projection),
      clampPageSize(req.pageSize),
      cursor,
    );
    return {
      messages: rows.map(toMessageWire),
      nextPageToken: nextCursor ? encodeCursor(nextCursor) : '',
    };
  }
}

/** ChatsWriteService — post a reply / private note, and (internal/seed) record an incoming message. */
@Controller()
@UseGuards(ChatsAccessGuard)
export class MessageWriteController {
  constructor(@Inject(MessageRepository) private readonly repo: MessageRepository) {}

  @GrpcMethod('ChatsWriteService', 'PostMessage')
  @RequiresChatsPermission('crm.conversation.reply')
  async postMessage(req: PostMessageRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    const isPrivate = req.kind === 'MESSAGE_KIND_PRIVATE_NOTE';
    const isReply = req.kind === 'MESSAGE_KIND_PUBLIC_REPLY';
    if (!isPrivate && !isReply) {
      // Only agent-authored kinds are postable here (incoming/system are not).
      throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid kind' });
    }
    await assertConversationAccess(this.repo, ctx, req.conversationId);
    const row = await this.repo.post(ctx.accountId, {
      conversationId: req.conversationId,
      authorType: 'operator',
      authorId: ctx.userId || null,
      body: req.body ?? '',
      isPrivate,
      mentions: req.mentions ?? [],
    });
    return toMessageWire(row);
  }

  @GrpcMethod('ChatsWriteService', 'RecordIncomingMessage')
  @RequiresChatsPermission('crm.conversation.reply')
  async recordIncomingMessage(req: RecordIncomingRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    await assertConversationAccess(this.repo, ctx, req.conversationId);
    const row = await this.repo.post(ctx.accountId, {
      conversationId: req.conversationId,
      authorType: 'player',
      authorId: req.authorId || null,
      body: req.body ?? '',
      isPrivate: false,
      mentions: [],
    });
    return toMessageWire(row);
  }
}
