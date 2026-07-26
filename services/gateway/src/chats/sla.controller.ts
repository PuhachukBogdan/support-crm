import { BadRequestException, Body, Controller, Get, Inject, OnModuleInit, Put, Req } from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { type Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { CHATS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { buildActorMetadata } from './actor-metadata';
import { callChats } from './rpc';

interface PolicyListWire {
  policies: unknown[];
}
interface PolicyWire {
  id: string;
}
interface ChatsReadGrpc {
  getFirstReplySlaPolicies(d: Record<string, unknown>, md?: unknown): Observable<PolicyListWire>;
}
interface ChatsWriteGrpc {
  setFirstReplySlaPolicy(d: Record<string, unknown>, md?: unknown): Observable<PolicyWire>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

interface SetPolicyBody {
  targetMinutes?: number | string;
  scopePriority?: string;
  scopeBrandId?: string;
}

/**
 * First-reply SLA policy REST edge (feature 014, US2 — roadmap 4.7). `crm.sla.manage` on both routes.
 *
 * The breached LIST is deliberately not here: it is `GET /conversations?slaOutcome=breached` (research
 * R10). "Show me what we missed" is a filter on the inbox, which is how a supervisor actually works, and
 * a filter inherits keyset paging, the page cap, the brand intersection and `crm.inbox.view` for free.
 * A parallel endpoint would have to re-implement all four and would drift from them.
 */
@Controller()
export class SlaController implements OnModuleInit {
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

  @Get('sla/first-reply')
  @RequiresPermission('crm.sla.manage')
  async get(@Req() req: ChatsReq) {
    return callChats(this.read.getFirstReplySlaPolicies({}, this.meta(req)));
  }

  @Put('sla/first-reply')
  @RequiresPermission('crm.sla.manage')
  async set(@Body() body: SetPolicyBody, @Req() req: ChatsReq) {
    const target = Math.trunc(Number(body?.targetMinutes));
    if (!Number.isFinite(target) || target <= 0) {
      // Refused at the edge: a zero/negative target would mean "breach immediately, forever".
      throw new BadRequestException('invalid targetMinutes: expected a positive number of minutes');
    }
    const scopePriority = (body?.scopePriority ?? '').trim();
    const scopeBrandId = (body?.scopeBrandId ?? '').trim();
    // '*' is the "any scope" sentinel (research R7); omit the field to mean any.
    if (scopePriority === '*' || scopeBrandId === '*') {
      throw new BadRequestException("invalid scope: '*' is reserved — omit the field to mean any");
    }
    return callChats(
      this.write.setFirstReplySlaPolicy(
        { targetMinutes: target, scopePriority, scopeBrandId },
        this.meta(req),
      ),
    );
  }
}
