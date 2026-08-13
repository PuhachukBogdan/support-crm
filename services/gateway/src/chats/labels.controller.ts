import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Post,
  Put,
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

interface LabelWire {
  id: string;
}
interface LabelListWire {
  labels: unknown[];
}
interface AckWire {
  ok: boolean;
}
interface ChatsReadGrpc {
  listLabels(d: Record<string, unknown>, md?: unknown): Observable<LabelListWire>;
  listConversationLabels(d: Record<string, unknown>, md?: unknown): Observable<LabelListWire>;
  // ⭐ W16 (subpoint 3.11): the registry — labels with usage counts.
  listLabelUsage(d: Record<string, unknown>, md?: unknown): Observable<LabelListWire>;
}
interface ChatsWriteGrpc {
  createLabel(d: Record<string, unknown>, md?: unknown): Observable<LabelWire>;
  attachLabel(d: Record<string, unknown>, md?: unknown): Observable<AckWire>;
  detachLabel(d: Record<string, unknown>, md?: unknown): Observable<AckWire>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

/**
 * Labels REST edge (feature 013, US2 — roadmap 4.5). Thin proxy over the chats gRPC service; RBAC
 * (`crm.labels.manage`) enforced by the global PermissionGuard, identity + brands from the validated
 * claims. All calls go through `callChats` so downstream statuses map to HTTP (feature-012 Track-B
 * lesson) — notably a foreign-brand conversation answering NOT_FOUND becomes a 404, not a 500.
 *
 * The account label set lives at `/labels`; the per-conversation links live under the conversation.
 */
@Controller()
export class LabelsController implements OnModuleInit {
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

  @Get('labels')
  @RequiresPermission('crm.labels.manage')
  async list(@Req() req: ChatsReq) {
    return callChats(this.read.listLabels({}, this.meta(req)));
  }

  /**
   * ⭐ W16 (subpoint 3.11) — the tag registry: every label with how many conversations carry it.
   * Same key as the set itself — the registry is the vocabulary enriched with an aggregate, and a
   * count is not customer data. ⚠️ Declared ABOVE any parameterised sibling so `usage` can never be
   * read as a label id.
   */
  @Get('labels/usage')
  @RequiresPermission('crm.labels.manage')
  async usage(@Req() req: ChatsReq) {
    const res = await callChats(this.read.listLabelUsage({}, this.meta(req)));
    // proto3 omits an empty repeated field; "no labels" is a state, not a crash.
    return { labels: res.labels ?? [] };
  }

  @Post('labels')
  @RequiresPermission('crm.labels.manage')
  async create(@Body() body: { name?: string; color?: string }, @Req() req: ChatsReq) {
    return callChats(
      this.write.createLabel(
        { name: (body?.name ?? '').trim(), color: (body?.color ?? '').trim() },
        this.meta(req),
      ),
    );
  }

  @Get('conversations/:id/labels')
  @RequiresPermission('crm.labels.manage')
  async listForConversation(@Param('id') id: string, @Req() req: ChatsReq) {
    return callChats(this.read.listConversationLabels({ conversationId: id }, this.meta(req)));
  }

  /** Idempotent attach (re-attaching changes nothing — SC-006). */
  @Put('conversations/:id/labels/:labelId')
  @RequiresPermission('crm.labels.manage')
  async attach(
    @Param('id') id: string,
    @Param('labelId') labelId: string,
    @Req() req: ChatsReq,
  ) {
    return callChats(
      this.write.attachLabel({ conversationId: id, labelId }, this.meta(req)),
    );
  }

  /** Idempotent detach (detaching an absent link is a no-op — SC-006). */
  @Delete('conversations/:id/labels/:labelId')
  @RequiresPermission('crm.labels.manage')
  async detach(
    @Param('id') id: string,
    @Param('labelId') labelId: string,
    @Req() req: ChatsReq,
  ) {
    return callChats(
      this.write.detachLabel({ conversationId: id, labelId }, this.meta(req)),
    );
  }
}
