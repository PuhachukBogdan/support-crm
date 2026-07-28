import {
  Controller,
  Get,
  Inject,
  OnModuleInit,
  Param,
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

interface ConversationPageWire {
  conversations: unknown[];
  nextPageToken: string;
}
interface ChatsReadGrpc {
  getPlayerFeed(d: Record<string, unknown>, md?: unknown): Observable<ConversationPageWire>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

/**
 * Player feed REST edge (feature 012, US3). `GET /players/:playerId/feed` → the player's
 * conversations merged across brands within the account (server-side). Thin proxy; RBAC via the
 * global PermissionGuard; identity + permitted brands travel as `x-actor-*` metadata (R1/R3).
 */
@Controller('players/:playerId')
export class FeedController implements OnModuleInit {
  private read!: ChatsReadGrpc;

  constructor(@Inject(CHATS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.read = this.client.getService<ChatsReadGrpc>('ChatsReadService');
  }

  @Get('feed')
  @RequiresPermission('crm.inbox.view')
  async feed(
    @Param('playerId') playerId: string,
    @Query() q: { pageToken?: string; pageSize?: string },
    @Req() req: ChatsReq,
  ) {
    const md = buildActorMetadata(req.claims!, req.effective);
    return callChats(
      this.read.getPlayerFeed(
        {
          playerId,
          pageToken: q.pageToken ?? '',
          pageSize: q.pageSize ? Number(q.pageSize) : 0,
        },
        md,
      ),
    );
  }
}
