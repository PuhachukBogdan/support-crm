import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Patch,
  Query,
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
import {
  toStatusKey,
  toStatusCategoryWire,
  toSlaOutcomeWire,
  toSubjectWire,
  toChannelFilter,
  toConversationOrderWire,
} from './wire';

interface ConversationPageWire {
  conversations: unknown[];
  nextPageToken: string;
}
interface ConversationWire {
  id: string;
}
interface ChatsReadGrpc {
  listConversations(d: Record<string, unknown>, md?: unknown): Observable<ConversationPageWire>;
  getConversation(d: { id: string }, md?: unknown): Observable<ConversationWire>;
  // Feature 032 (roadmap 4.16): the account's configured statuses, read once per screen.
  listConversationStatuses(d: Record<string, never>, md?: unknown): Observable<unknown>;
}
interface ChatsWriteGrpc {
  setConversationStatus(
    d: { conversationId: string; statusKey: string },
    md?: unknown,
  ): Observable<ConversationWire>;
  // Feature 032 (roadmap 4.16 — R22): the one field an agent may not change.
  setConversationBrand(
    d: { conversationId: string; brandId: string },
    md?: unknown,
  ): Observable<ConversationWire>;
  // Feature 023 (roadmap 4.18): a person names the conversation, which locks the title.
  setConversationSubject(
    d: { conversationId: string; subject: string },
    md?: unknown,
  ): Observable<ConversationWire>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

/**
 * Conversations REST edge (feature 012, US1). Thin proxy over the chats gRPC service (Principle
 * VIII — no business logic). RBAC enforced by the global PermissionGuard via `@RequiresPermission`
 * (SC-004); caller identity + permitted brands travel as `x-actor-*` metadata (R1/R3), built from
 * the VALIDATED claims + the guard-resolved effective permissions — never the body.
 */
@Controller('conversations')
export class ConversationsController implements OnModuleInit {
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

  @Get()
  @RequiresPermission('crm.inbox.view')
  async list(
    @Query()
    q: {
      status?: string;
      priority?: string;
      assigneeOperatorId?: string;
      playerId?: string;
      brandId?: string;
      pageToken?: string;
      pageSize?: string;
      /** Feature 014 (R10): running | met | breached — the "what did we miss" filter. */
      slaOutcome?: string;
      /**
       * Feature 029 (roadmap 9.2). ⚠️ This object is a FIXED DESTRUCTURE: a query parameter that is
       * not named here is silently dropped, and the caller gets a wider result set believing it was
       * narrowed. Adding the field to this type is the whole of "the route accepts it".
       */
      channel?: string;
      /** Feature 029: updated_desc (default) | updated_asc. Unknown ⇒ 400, never the default. */
      order?: string;
      /**
       * ⭐ Feature 032 (roadmap 4.16). `status` IS the key now — free-form here on purpose: the account's
       * catalogue is data this tier has no copy of, and `chats` refuses an unknown key against it.
       * `statusCategory` is the closed six, so it fails closed at this edge like `order`.
       */
      statusCategory?: string;
    },
    @Req() req: ChatsReq,
  ) {
    return callChats(
      this.read.listConversations(
        {
          // Feature 032: the retired `status` ENUM field is deliberately never sent — chats refuses it.
          statusKey: (q.status ?? '').trim(),
          statusCategory: toStatusCategoryWire(q.statusCategory),
          priority: q.priority ?? '',
          assigneeOperatorId: q.assigneeOperatorId ?? '',
          playerId: q.playerId ?? '',
          brandId: q.brandId ?? '',
          // Fail-closed like every other filter: an unknown value is a 400, never a silently widened
          // query (the feature-012 lesson — a mistyped filter that returns EVERYTHING is worse than an
          // error, because it looks like it worked).
          slaOutcome: toSlaOutcomeWire(q.slaOutcome),
          // Feature 029. `order` is fail-closed like status — a closed vocabulary, so an unknown value
          // is a mistake. `channel` is shape-checked only: a channel is data, never a branch (roadmap
          // 9.6a), and an unrecognised one narrows to zero rather than widening. See `wire.ts`.
          channel: toChannelFilter(q.channel),
          order: toConversationOrderWire(q.order),
          pageToken: q.pageToken ?? '',
          pageSize: q.pageSize ? Number(q.pageSize) : 0,
        },
        this.meta(req),
      ),
    );
  }

  /**
   * ⭐ Feature 032 (roadmap 4.16) — `GET /conversations/statuses`, the account's status catalogue.
   *
   * ⚠️ **DECLARED ABOVE `:id`, and it must stay there.** Nest matches routes in declaration order, so
   * with these two swapped `GET /conversations/statuses` becomes a conversation lookup for the id
   * `"statuses"` — a 404 that looks like a missing ticket rather than a mis-ordered route.
   *
   * Gated by `crm.inbox.view`: reading the words the list is labelled with is the same fact class as
   * reading the list.
   */
  @Get('statuses')
  @RequiresPermission('crm.inbox.view')
  async statuses(@Req() req: ChatsReq) {
    return callChats(this.read.listConversationStatuses({}, this.meta(req)));
  }

  @Get(':id')
  @RequiresPermission('crm.inbox.view')
  async get(@Param('id') id: string, @Req() req: ChatsReq) {
    return callChats(this.read.getConversation({ id }, this.meta(req)));
  }

  @Patch(':id/status')
  @RequiresPermission('crm.conversation.reply')
  async setStatus(@Param('id') id: string, @Body() body: { status: string }, @Req() req: ChatsReq) {
    return callChats(
      this.write.setConversationStatus(
        { conversationId: id, statusKey: toStatusKey(body?.status) },
        this.meta(req),
      ),
    );
  }

  /**
   * Feature 023 (roadmap 4.18) — `PATCH /conversations/:id/subject`.
   *
   * On the EXISTING conversation route surface and behind the EXISTING permission: naming a ticket is
   * not a new kind of authority. The over-length refusal is enforced by the owning service and mapped
   * here by `callChats`, which turns INVALID_ARGUMENT into a 400 carrying **no downstream detail** —
   * the value is a human's words, and a message that echoed it would put them in a client log.
   *
   * The 400 for a MISSING body is raised at the edge for the same reason every other fail-closed
   * parser here does it: an absent field must never become a silently-chosen default.
   */
  @Patch(':id/subject')
  @RequiresPermission('crm.conversation.reply')
  async setSubject(@Param('id') id: string, @Body() body: { subject?: string }, @Req() req: ChatsReq) {
    return callChats(
      this.write.setConversationSubject(
        { conversationId: id, subject: toSubjectWire(body?.subject) },
        this.meta(req),
      ),
    );
  }

  /**
   * ⭐ Feature 032 (roadmap 4.16 — R22) — `PATCH /conversations/:id/brand`.
   *
   * Its own permission, not `crm.conversation.reply`: brand is set at ingestion, chosen when a ticket is
   * raised by hand, and **read-only for agents** — a supervisor corrects it, and the correction is
   * audited in the owning service, inside the update's transaction.
   *
   * The gateway checks the SHAPE only. Whether the brand exists is not this tier's question (brand ids
   * are soft refs across a service boundary), and whether the conversation exists must not be answerable
   * by an unauthorised caller at all — which is why the permission is on the route rather than after.
   */
  @Patch(':id/brand')
  @RequiresPermission('crm.conversation.set_brand')
  async setBrand(@Param('id') id: string, @Body() body: { brandId?: string }, @Req() req: ChatsReq) {
    const brandId = (body?.brandId ?? '').trim();
    if (!brandId) throw new BadRequestException('invalid brandId: must not be empty');
    return callChats(this.write.setConversationBrand({ conversationId: id, brandId }, this.meta(req)));
  }
}
