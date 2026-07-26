import {
  Body,
  Controller,
  Delete,
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

interface ConversationWire {
  id: string;
}
interface AutoAssignResultWire {
  assigned: boolean;
  operatorId: string;
  reason: string;
}
interface ChatsWriteGrpc {
  assignConversation(d: Record<string, unknown>, md?: unknown): Observable<ConversationWire>;
  autoAssignConversation(d: Record<string, unknown>, md?: unknown): Observable<AutoAssignResultWire>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

interface CandidateBody {
  operatorId?: string;
  capacity?: number;
  currentLoad?: number;
}

/**
 * Assignment REST edge (feature 013, US1 + US3 — roadmap 4.4). Thin proxy over the chats gRPC
 * service (Principle VIII — no business logic here). RBAC via the global PermissionGuard
 * (`crm.conversation.assign`); identity + permitted brands travel as `x-actor-*` metadata built
 * from the VALIDATED claims, never the body.
 *
 * Every call goes through `callChats` so a downstream `NOT_FOUND` becomes a 404 rather than a raw
 * 500 (the feature-012 Track-B lesson).
 */
@Controller('conversations/:id')
export class AssignmentController implements OnModuleInit {
  private write!: ChatsWriteGrpc;

  constructor(@Inject(CHATS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.write = this.client.getService<ChatsWriteGrpc>('ChatsWriteService');
  }

  private meta(req: ChatsReq) {
    return buildActorMetadata(req.claims!, req.effective?.permissionKeys ?? []);
  }

  /** Assign or reassign. */
  @Put('assignee')
  @RequiresPermission('crm.conversation.assign')
  async assign(
    @Param('id') id: string,
    @Body() body: { operatorId?: string },
    @Req() req: ChatsReq,
  ) {
    return callChats(
      this.write.assignConversation(
        { conversationId: id, operatorId: (body?.operatorId ?? '').trim() },
        this.meta(req),
      ),
    );
  }

  /** Unassign: the same RPC with an empty operator id (the service stores NULL). */
  @Delete('assignee')
  @RequiresPermission('crm.conversation.assign')
  async unassign(@Param('id') id: string, @Req() req: ChatsReq) {
    return callChats(
      this.write.assignConversation({ conversationId: id, operatorId: '' }, this.meta(req)),
    );
  }

  /**
   * Round-robin auto-assign (US3). Candidates are supplied by the caller until the Users service
   * resolves teams + capacity (roadmap 5.3 / research R3) — the gateway makes no Users call here,
   * and an absent candidate set is answered by the service with GROUP_ROUTING_NOT_AVAILABLE rather
   * than a guess.
   */
  @Post('auto-assign')
  @RequiresPermission('crm.conversation.assign')
  async autoAssign(
    @Param('id') id: string,
    @Body() body: { groupKey?: string; candidates?: CandidateBody[] },
    @Req() req: ChatsReq,
  ) {
    const candidates = (Array.isArray(body?.candidates) ? body.candidates : []).map((c) => ({
      operatorId: (c?.operatorId ?? '').trim(),
      capacity: Number(c?.capacity ?? 0),
      currentLoad: Number(c?.currentLoad ?? 0),
    }));
    return callChats(
      this.write.autoAssignConversation(
        { conversationId: id, groupKey: (body?.groupKey ?? '').trim(), candidates },
        this.meta(req),
      ),
    );
  }
}
