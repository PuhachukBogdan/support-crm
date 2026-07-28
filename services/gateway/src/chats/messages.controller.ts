import {
  BadRequestException,
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
import { type Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { CHATS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { buildActorMetadata } from './actor-metadata';
import { callChats } from './rpc';
import { toKindWire, toProjectionWire } from './wire';

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
    return buildActorMetadata(req.claims!, req.effective);
  }

  @Get('thread')
  @RequiresPermission('crm.inbox.view')
  async thread(
    @Param('id') id: string,
    @Query() q: { projection?: string; pageToken?: string; pageSize?: string },
    @Req() req: ChatsReq,
  ) {
    return callChats(
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
    @Body() body: { kind?: string; body?: string; mentions?: string[]; uploadIds?: unknown },
    @Req() req: ChatsReq,
  ) {
    return callChats(
      this.write.postMessage(
        {
          conversationId: id,
          kind: toKindWire(body?.kind),
          body: body?.body ?? '',
          mentions: body?.mentions ?? [],
          uploadIds: readUploadIds(body?.uploadIds),
        },
        this.meta(req),
      ),
    );
  }
}

/**
 * Feature 016 — the REST edge must not COERCE (the feature-012 lesson).
 *
 * That lesson cost a real defect: the edge silently turned an unknown `kind` into a public reply, so
 * `{"kind":"private_note"}` published an internal note to the customer. The failure was not that the
 * value was wrong; it was that a malformed value became a valid one. So anything that is not an
 * array of non-empty strings is a 400 here, never a silently emptied list — an upload the caller
 * believes they attached must not vanish into a successful-looking reply.
 *
 * The cap is enforced again in chats and again in users. Three tiers, because a caller can reach the
 * second and third directly.
 */
const MAX_UPLOAD_IDS = 50;

function readUploadIds(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new BadRequestException('uploadIds must be an array');
  if (raw.length > MAX_UPLOAD_IDS) throw new BadRequestException('too many uploadIds');
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new BadRequestException('uploadIds must be non-empty strings');
    }
  }
  return raw as string[];
}
