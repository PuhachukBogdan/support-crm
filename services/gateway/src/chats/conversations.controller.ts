import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Patch,
  Post,
  Put,
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
  // Feature 033 (roadmap 6.6): the capability matrix. Product facts, no account in the request.
  getChannelCapabilities(d: Record<string, never>, md?: unknown): Observable<unknown>;
  // W9 / spec 035: the context-gated lookup — chats verifies the conversation is unidentified and
  // dials users with the CALLER's credentials; this edge only forwards.
  lookupContactForConversation(
    d: { conversationId: string; kind: string; value: string },
    md?: unknown,
  ): Observable<unknown>;
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
  // W9 / spec 035 (ADR 0044 §5): the reversible identity pair, both under crm.contact.lookup.
  setConversationPlayer(
    d: { conversationId: string; playerId: string },
    md?: unknown,
  ): Observable<ConversationWire>;
  detachConversationPlayer(d: { conversationId: string }, md?: unknown): Observable<unknown>;
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
      /**
       * W5 (R38): the PLURAL — comma-separated (`statusCategories=pending,on_hold`), because one rail
       * bucket is a union the singular cannot say. Each entry fails closed like the singular.
       */
      statusCategories?: string;
      /** W5 (roadmap 4.19): only conversations this operator has OPENED — the rail's middle leg. */
      openedByOperatorId?: string;
    },
    @Req() req: ChatsReq,
  ) {
    return callChats(
      this.read.listConversations(
        {
          // Feature 032: the retired `status` ENUM field is deliberately never sent — chats refuses it.
          statusKey: (q.status ?? '').trim(),
          statusCategory: toStatusCategoryWire(q.statusCategory),
          statusCategories: (q.statusCategories ?? '')
            .split(',')
            .map((c) => c.trim())
            .filter(Boolean)
            .map((c) => toStatusCategoryWire(c)),
          priority: q.priority ?? '',
          assigneeOperatorId: q.assigneeOperatorId ?? '',
          openedByOperatorId: q.openedByOperatorId ?? '',
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

  /**
   * ⭐ Feature 033 (roadmap 6.6) — `GET /conversations/channel-capabilities`: what each channel kind can do.
   *
   * ⚠️ **ABOVE `:id`, for the reason the route above states**, and under `/conversations` rather than at
   * `/channels/…` deliberately: `/channels/:key/inbound` is the PUBLIC intake route, which is `@Public()`
   * and authenticated by a signature. Hanging an authenticated read off the same prefix would put two
   * completely different authentication stories under one path — the arrangement in which somebody
   * eventually makes the wrong one apply.
   *
   * Static product facts, not account configuration, and gated on `crm.inbox.view` like the catalogue
   * above: reading the vocabulary the inbox is described with is the same fact class as reading the inbox.
   */
  @Get('channel-capabilities')
  @RequiresPermission('crm.inbox.view')
  async channelCapabilities(@Req() req: ChatsReq) {
    return callChats(this.read.getChannelCapabilities({}, this.meta(req)));
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

  /**
   * ⭐ W9 / spec 035 (ADR 0044 §4) — the lookup, reachable ONLY under a conversation. A POST,
   * deliberately: the searched value must ride the BODY (a query string is written to every proxy
   * log between the browser and this service — the same rule the auth routes state). Validation
   * errors name the KEY, never the value: the value is a customer contact by definition (SEC-26).
   * Everything else — the unidentified check, the audit, the cap — is the services' business.
   */
  @Post(':id/contact-lookup')
  @RequiresPermission('crm.contact.lookup')
  async contactLookup(
    @Param('id') id: string,
    @Body() body: { kind?: string; value?: string },
    @Req() req: ChatsReq,
  ) {
    const kind = body?.kind === 'email' || body?.kind === 'phone' ? body.kind : null;
    const value = (body?.value ?? '').trim();
    if (!kind || !value) throw new BadRequestException('kind (email|phone) and value are required');
    return callChats(
      this.read.lookupContactForConversation({ conversationId: id, kind, value }, this.meta(req)),
    );
  }

  /** W9 (0044 §5): attach = an idempotent-shaped PLACEMENT of the pair the lookup confirmed. */
  @Put(':id/player')
  @RequiresPermission('crm.contact.lookup')
  async setPlayer(@Param('id') id: string, @Body() body: { playerId?: string }, @Req() req: ChatsReq) {
    const playerId = (body?.playerId ?? '').trim();
    if (!playerId) throw new BadRequestException('invalid playerId: must not be empty');
    return callChats(this.write.setConversationPlayer({ conversationId: id, playerId }, this.meta(req)));
  }

  /** W9 (0044 §5): the response is the WARNING — what staff wrote while the player was attached. */
  @Delete(':id/player')
  @RequiresPermission('crm.contact.lookup')
  async detachPlayer(@Param('id') id: string, @Req() req: ChatsReq) {
    return callChats(this.write.detachConversationPlayer({ conversationId: id }, this.meta(req)));
  }
}
