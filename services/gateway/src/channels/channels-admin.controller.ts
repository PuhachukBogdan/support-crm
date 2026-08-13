import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Put,
  Req,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import type { Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { CHATS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { buildActorMetadata } from '../chats/actor-metadata';
import { callChats } from '../chats/rpc';

interface ChannelConfigWire {
  id: string;
  brandId: string;
  kind: string;
  key: string;
  address: string;
  enabled: boolean;
}
interface ChannelsAdminReadGrpc {
  listChannels(d: Record<string, never>, md: unknown): Observable<{ channels?: ChannelConfigWire[] }>;
}
interface ChannelsAdminWriteGrpc {
  upsertEmailChannel(d: { brandId: string; address: string }, md: unknown): Observable<ChannelConfigWire>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

/**
 * ⭐ W15 (roadmap 6.8 minimum, subpoint 3.10) — the channels ADMIN edge.
 *
 * ── `/admin/channels`, deliberately NOT under `/channels` ────────────────────────────────────────
 * `/channels/:key/inbound` is the PUBLIC intake route — `@Public()`, authenticated by a signature.
 * The same reasoning that put `channel-capabilities` under `/conversations` applies here with more
 * force, because this surface is configuration: two authentication stories must not share a prefix,
 * and this one lives beside `/admin/access` where the caller is always a session.
 *
 * Thin proxy (Principle VIII): `platform.settings.manage` at this tier via the global guard, and the
 * chats handlers re-check the same key from `x-actor-permissions` — a call that skips this edge is
 * refused there (Principle II).
 */
@Controller('admin/channels')
export class ChannelsAdminController implements OnModuleInit {
  private read!: ChannelsAdminReadGrpc;
  private write!: ChannelsAdminWriteGrpc;

  constructor(@Inject(CHATS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.read = this.client.getService<ChannelsAdminReadGrpc>('ChatsReadService');
    this.write = this.client.getService<ChannelsAdminWriteGrpc>('ChatsWriteService');
  }

  private meta(req: ChatsReq) {
    return buildActorMetadata(req.claims!, req.effective);
  }

  @Get()
  @RequiresPermission('platform.settings.manage')
  async list(@Req() req: ChatsReq) {
    const res = await callChats(this.read.listChannels({}, this.meta(req)));
    // proto3 omits an empty repeated field; the screen must read "no channels" as a state, not a crash.
    return { channels: res.channels ?? [] };
  }

  /**
   * PUT — an idempotent PLACEMENT of a brand's mail address (the assignee/label verb rule from W7):
   * a brand with no email channel gets one, a brand with one gets its address changed. The service
   * refuses a no-op, an invalid address, and — through the unique constraint — a concurrent
   * duplicate; each maps to its own status via `callChats`.
   */
  @Put('email/:brandId')
  @RequiresPermission('platform.settings.manage')
  async upsertEmail(
    @Param('brandId') brandId: string,
    @Body() body: { address?: string },
    @Req() req: ChatsReq,
  ) {
    // Read into a local first: `body?.address === …` is the exact shape the no-channel-name-branch
    // guard scans for (an identity comparison), and this is a TYPE check, not one — restructured so
    // the guard does not have to learn an exception.
    const raw = body?.address;
    const address = typeof raw === 'string' ? raw.trim() : '';
    if (!address) throw new BadRequestException('address is required');
    return callChats(this.write.upsertEmailChannel({ brandId, address }, this.meta(req)));
  }
}
