import { Body, Controller, Get, Inject, OnModuleInit, Post, Req } from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { type Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { CHATS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { buildActorMetadata } from './actor-metadata';
import { callChats } from './rpc';

interface CannedWire {
  id: string;
}
interface CannedListWire {
  canned: unknown[];
}
interface ChatsReadGrpc {
  listCannedResponses(d: Record<string, unknown>, md?: unknown): Observable<CannedListWire>;
}
interface ChatsWriteGrpc {
  createCannedResponse(d: Record<string, unknown>, md?: unknown): Observable<CannedWire>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

/**
 * Canned-response REST edge (feature 013, US2 — roadmap 4.5). `crm.templates.manage` (authoring is
 * a configuration task). **Text only**: these routes return reply text for the agent to insert; the
 * reply itself is sent through the feature-012 message path (FR-009). No route here can send.
 */
@Controller('canned-responses')
export class CannedController implements OnModuleInit {
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
  @RequiresPermission('crm.templates.manage')
  async list(@Req() req: ChatsReq) {
    return callChats(this.read.listCannedResponses({}, this.meta(req)));
  }

  @Post()
  @RequiresPermission('crm.templates.manage')
  async create(@Body() body: { name?: string; body?: string }, @Req() req: ChatsReq) {
    return callChats(
      this.write.createCannedResponse(
        { name: (body?.name ?? '').trim(), body: (body?.body ?? '').trim() },
        this.meta(req),
      ),
    );
  }
}
