import { Controller, Inject, UseGuards } from '@nestjs/common';
import { GrpcMethod, RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { ChatsAccessGuard } from '../security/permission.guard';
import { RequiresChatsPermission } from '../security/requires-chats-permission.decorator';
import { readActorContext, type ActorContext } from '../security/actor-context';
import { clampPageSize, decodeCursor, encodeCursor, InvalidCursorError } from '../shared/cursor';
import { toMessageWire, projectionFromWire } from '../shared/wire';
import { DomainEventPublisher } from '../events/events.publisher';
import { FirstReplyClock } from '../sla/first-reply.clock';
import { UploadsClient, UploadsUnavailableError } from '../uploads/uploads.client';
import type { AttachmentWire } from '../shared/wire';
import { MessageRepository } from './message.repository';
import { userActor } from '../transition/conversation-transitions';

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
  /** Feature 016 — capped at 50, like every other id list on this contract (FR-023). */
  uploadIds?: string[];
}

/** Matches the cap enforced by `users` on `ClaimUploads`/`DescribeUploads`. */
const MAX_UPLOAD_IDS = 50;
interface RecordIncomingRequestWire {
  conversationId: string;
  body?: string;
  authorId?: string;
}

const notFound = () => new RpcException({ code: GrpcStatus.NOT_FOUND, message: 'not found' });

/**
 * Validate an inbound upload-id list (feature 016): all strings, no blanks, within the cap.
 *
 * The cap is re-asserted here as well as in `users` because a caller that reaches chats directly
 * must hit the same wall — an unbounded `repeated string` on an authenticated path is an unbounded
 * request (Principle VII / FR-023). Refused BEFORE any cross-service call, so an oversized list
 * costs one comparison rather than a hop.
 */
function readUploadIds(raw: string[] | undefined): string[] {
  const ids = Array.isArray(raw) ? raw : [];
  if (ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'invalid upload id' });
  }
  if (ids.length > MAX_UPLOAD_IDS) {
    throw new RpcException({ code: GrpcStatus.INVALID_ARGUMENT, message: 'too many upload ids' });
  }
  return [...new Set(ids)];
}

/**
 * Normalise a failure from the uploads edge into an RpcException.
 *
 * `UploadsUnavailableError` becomes UNAVAILABLE — fail-closed, and distinguishable in a log from a
 * refused claim, which is a client error. Neither carries a detail from the downstream response.
 */
function toRpc(err: unknown): RpcException {
  if (err instanceof RpcException) return err;
  if (err instanceof UploadsUnavailableError) {
    return new RpcException({ code: GrpcStatus.UNAVAILABLE, message: 'attachments unavailable' });
  }
  if (typeof (err as { code?: number })?.code === 'number') {
    return new RpcException({
      code: GrpcStatus.FAILED_PRECONDITION,
      message: 'invalid attachment',
    });
  }
  return new RpcException({ code: GrpcStatus.UNAVAILABLE, message: 'attachments unavailable' });
}

/** Index descriptions by upload id so the wire mapper is a lookup, not a scan per message. */
function indexByUploadId(rows: AttachmentWire[]): Map<string, AttachmentWire> {
  return new Map(rows.map((r) => [r.uploadId, r]));
}

/** Shared brand resource-check: the conversation must exist in-account AND be a permitted brand. */
async function assertConversationAccess(
  repo: MessageRepository,
  ctx: ActorContext,
  conversationId: string,
): Promise<void> {
  const brand = await repo.conversationBrand(ctx.accountId, conversationId);
  if (brand === null) throw notFound();
}

/** ChatsReadService.GetThread — STAFF (all kinds) vs CUSTOMER (private notes excluded, R4). */
@Controller()
@UseGuards(ChatsAccessGuard)
export class MessageReadController {
  constructor(
    @Inject(MessageRepository) private readonly repo: MessageRepository,
    @Inject(UploadsClient) private readonly uploads: UploadsClient,
  ) {}

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
    // T051 — ONE DescribeUploads per thread page, never one per message (Principle VII, no N+1).
    // The metadata is fetched, deliberately NOT denormalized into chats_db: that keeps the
    // PII-capable `display_name` in exactly one database, so "where can a filename be" has one
    // answer. Only the ids the page actually returned are asked for — a private note excluded at the
    // query contributes no ids, which is why SEC-13 needs nothing extra here.
    const described = await this.describeForPage(rows, metadata);
    return {
      // Wrapped rather than point-free: `Array.map` would pass the index as the second argument,
      // which is now the description map. A silent type coincidence away from a real bug.
      messages: rows.map((row) => toMessageWire(row, described)),
      nextPageToken: nextCursor ? encodeCursor(nextCursor) : '',
    };
  }

  /**
   * Resolve attachment metadata for one page of messages.
   *
   * A failure here degrades to NO attachment metadata rather than failing the whole thread read: the
   * conversation is the thing the operator needs, and a missing thumbnail is not worth a blank
   * screen. That is the opposite of the WRITE path, where an unresolvable upload refuses the message
   * outright — because there the operator believes a file was sent.
   */
  private async describeForPage(
    rows: Array<{ attachments?: Array<{ upload_id: string }> }>,
    metadata: Metadata,
  ): Promise<Map<string, AttachmentWire> | undefined> {
    const ids = [...new Set(rows.flatMap((r) => (r.attachments ?? []).map((a) => a.upload_id)))];
    if (ids.length === 0) return undefined;
    try {
      // The page size is server-capped (100), and a message carries at most 50 attachments, so this
      // list is bounded by construction — but it is chunked anyway so the cap is enforced by code
      // rather than by an argument about the other caps.
      const out = new Map<string, AttachmentWire>();
      for (let i = 0; i < ids.length; i += MAX_UPLOAD_IDS) {
        const chunk = ids.slice(i, i + MAX_UPLOAD_IDS);
        for (const row of await this.uploads.describe(chunk, metadata)) {
          out.set(row.uploadId, row);
        }
      }
      return out;
    } catch {
      return undefined;
    }
  }
}

/**
 * ChatsWriteService — post a reply / private note, and (internal/seed) record an incoming message.
 *
 * Feature 014 hangs two things off these edges:
 *  • the first-reply CLOCK — started by an inbound player message, stopped only by a **public** staff
 *    reply. A private note is deliberately inert (FR-012 / SEC-13 semantics).
 *  • the `message.received` EVENT — inbound player messages only. Publishing lives here, at the
 *    controller, and never in a repository, which is what makes a rule's own writes unable to cascade
 *    (FR-006 / research R4).
 */
@Controller()
@UseGuards(ChatsAccessGuard)
export class MessageWriteController {
  constructor(
    @Inject(MessageRepository) private readonly repo: MessageRepository,
    @Inject(DomainEventPublisher) private readonly events: DomainEventPublisher,
    @Inject(FirstReplyClock) private readonly clock: FirstReplyClock,
    @Inject(UploadsClient) private readonly uploads: UploadsClient,
  ) {}

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
    const uploadIds = readUploadIds(req.uploadIds);
    await assertConversationAccess(this.repo, ctx, req.conversationId);

    /**
     * Feature 016 — everything that can refuse runs BEFORE the first write (research R8, the 013
     * ordering discipline). Access is checked above; the uploads are described (which is where a
     * cross-account or nonexistent id disappears) and then claimed. Only after all of that does a
     * row get written, so a refused attachment leaves NO partial message (FR-015).
     *
     * Describe-then-claim rather than claim-then-describe: the response needs the metadata anyway,
     * and fetching it first means a failure to read it costs nothing. Claiming first and then
     * failing to describe would strand an upload in `claimed` for a message that was never posted.
     */
    let described: AttachmentWire[] = [];
    if (uploadIds.length > 0) {
      described = await this.describeOrRefuse(uploadIds, metadata);
      await this.claimOrRefuse(ctx.accountId, uploadIds, metadata);
    }

    const row = await this.repo.post(
        ctx.accountId,
        {
        conversationId: req.conversationId,
        authorType: 'operator',
        authorId: ctx.userId || null,
        body: req.body ?? '',
        isPrivate,
        mentions: req.mentions ?? [],
        uploadIds,
      },
      userActor(ctx.userId),
    );
    // Feature 014: only a PUBLIC reply stops the first-reply clock. A private note is routed here too
    // and resolves to no change — the rule lives in one place (decideStop) rather than at each call
    // site, so it cannot be forgotten on a future write path (FR-012 / SC-007).
    await this.clock.onStaffMessage(ctx.accountId, req.conversationId, isReply);
    return toMessageWire(row, indexByUploadId(described));
  }

  /**
   * Resolve metadata for the requested uploads, refusing unless EVERY id came back.
   *
   * A missing id is a cross-account id, a nonexistent id, or one this caller may not see — and the
   * three are deliberately indistinguishable here as well as in the response (FR-011). All three are
   * the same answer: this message cannot carry this file.
   */
  private async describeOrRefuse(ids: string[], metadata: Metadata): Promise<AttachmentWire[]> {
    let rows: AttachmentWire[];
    try {
      rows = await this.uploads.describe(ids, metadata);
    } catch (err) {
      throw toRpc(err);
    }
    if (rows.length !== ids.length) {
      throw new RpcException({ code: GrpcStatus.FAILED_PRECONDITION, message: 'invalid attachment' });
    }
    return rows;
  }

  private async claimOrRefuse(accountId: string, ids: string[], metadata: Metadata): Promise<void> {
    try {
      await this.uploads.claim(accountId, ids, metadata);
    } catch (err) {
      throw toRpc(err);
    }
  }

  @GrpcMethod('ChatsWriteService', 'RecordIncomingMessage')
  @RequiresChatsPermission('crm.conversation.reply')
  async recordIncomingMessage(req: RecordIncomingRequestWire, metadata: Metadata) {
    const ctx = readActorContext(metadata);
    await assertConversationAccess(this.repo, ctx, req.conversationId);
    const row = await this.repo.post(
        ctx.accountId,
        {
        conversationId: req.conversationId,
        authorType: 'player',
        authorId: req.authorId || null,
        body: req.body ?? '',
        isPrivate: false,
        mentions: [],
      },
      userActor(ctx.userId),
    );
    // Feature 014: an inbound player message both STARTS the first-reply clock and is what rules
    // react to. The clock first — a rule may change the conversation, and the measurement is of the
    // player's wait, not of the post-automation state.
    await this.clock.onInboundPlayerMessage(ctx.accountId, req.conversationId);
    await this.events.messageReceived(ctx.accountId, req.conversationId, row.id, row.body);
    return toMessageWire(row);
  }
}
