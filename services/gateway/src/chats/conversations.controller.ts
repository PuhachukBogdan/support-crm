import {
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
import { toStatusWire, toStatusWireRequired, toSlaOutcomeWire } from './wire';

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
}
interface ChatsWriteGrpc {
  setConversationStatus(
    d: { conversationId: string; status: string },
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
    return buildActorMetadata(req.claims!, req.effective?.permissionKeys ?? []);
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
    },
    @Req() req: ChatsReq,
  ) {
    return callChats(
      this.read.listConversations(
        {
          status: toStatusWire(q.status),
          priority: q.priority ?? '',
          assigneeOperatorId: q.assigneeOperatorId ?? '',
          playerId: q.playerId ?? '',
          brandId: q.brandId ?? '',
          // Fail-closed like every other filter: an unknown value is a 400, never a silently widened
          // query (the feature-012 lesson — a mistyped filter that returns EVERYTHING is worse than an
          // error, because it looks like it worked).
          slaOutcome: toSlaOutcomeWire(q.slaOutcome),
          pageToken: q.pageToken ?? '',
          pageSize: q.pageSize ? Number(q.pageSize) : 0,
        },
        this.meta(req),
      ),
    );
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
        { conversationId: id, status: toStatusWireRequired(body?.status) },
        this.meta(req),
      ),
    );
  }
}
