import {
  Body,
  Controller,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { CHATS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { buildActorMetadata } from './actor-metadata';

const toProjectionWire = (p?: string): string =>
  p === 'customer' ? 'THREAD_PROJECTION_CUSTOMER' : 'THREAD_PROJECTION_STAFF';
const toKindWire = (k?: string): string =>
  k === 'note' ? 'MESSAGE_KIND_PRIVATE_NOTE' : 'MESSAGE_KIND_PUBLIC_REPLY';

interface MessagePageWire {
  messages: unknown[];
  nextPageToken: string;
}
interface MessageWire {
  id: string;
}
interface ChatsReadGrpc {
  getThread(d: Record<string, unknown>, md?: unknown): Observable<MessagePageWire>;
}
interface ChatsWriteGrpc {
  postMessage(d: Record<string, unknown>, md?: unknown): Observable<MessageWire>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

/**
 * Messages REST edge (feature 012, US2). Thin proxy over the chats gRPC service. Reading the thread
 * defaults to the STAFF projection; `?projection=customer` requests the customer-facing view, which
 * the service builds WITHOUT private notes (SEC-13, enforced server-side — not here). RBAC via the
 * global PermissionGuard; identity + brands travel as `x-actor-*` metadata (R1/R3).
 */
@Controller('conversations/:id')
export class MessagesController implements OnModuleInit {
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

  @Get('thread')
  @RequiresPermission('crm.inbox.view')
  async thread(
    @Param('id') id: string,
    @Query() q: { projection?: string; pageToken?: string; pageSize?: string },
    @Req() req: ChatsReq,
  ) {
    return firstValueFrom(
      this.read.getThread(
        {
          conversationId: id,
          projection: toProjectionWire(q.projection),
          pageToken: q.pageToken ?? '',
          pageSize: q.pageSize ? Number(q.pageSize) : 0,
        },
        this.meta(req),
      ),
    );
  }

  @Post('messages')
  @RequiresPermission('crm.conversation.reply')
  async post(
    @Param('id') id: string,
    @Body() body: { kind?: string; body?: string; mentions?: string[] },
    @Req() req: ChatsReq,
  ) {
    return firstValueFrom(
      this.write.postMessage(
        {
          conversationId: id,
          kind: toKindWire(body?.kind),
          body: body?.body ?? '',
          mentions: body?.mentions ?? [],
        },
        this.meta(req),
      ),
    );
  }
}
