import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  OnModuleInit,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import type { Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { CHATS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { buildActorMetadata } from './actor-metadata';
import { callChats } from './rpc';

interface StatusDefWire {
  key: string;
  category: string;
  agentName: string;
  endUserName: string;
  active: boolean;
  order: number;
}
interface StatusesAdminWriteGrpc {
  createConversationStatus(
    d: { category: string; agentName: string; endUserName: string },
    md: unknown,
  ): Observable<StatusDefWire>;
  updateConversationStatus(
    d: { key: string; agentName: string; endUserName: string; category: string; setActive: boolean; active: boolean },
    md: unknown,
  ): Observable<StatusDefWire>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

/**
 * ⭐ W15a (subpoint 3.14) — the status authoring edge.
 *
 * ── Writes only. The READ stays where it is ──────────────────────────────────────────────────────
 * `GET /conversations/statuses` (feature 032, `crm.inbox.view`) already returns the whole catalogue
 * including retired rows, and the authoring screen reads it there: a second read route would be a
 * second projection to keep honest. The WRITES are tenant configuration and carry the configuration
 * key — the same split the people screen drew between seeing a list and changing what it means.
 *
 * Thin proxy (Principle VIII): `platform.settings.manage` here via the global guard, re-checked by
 * chats from `x-actor-permissions` (Principle II).
 */
@Controller('admin/statuses')
export class StatusesAdminController implements OnModuleInit {
  private write!: StatusesAdminWriteGrpc;

  constructor(@Inject(CHATS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.write = this.client.getService<StatusesAdminWriteGrpc>('ChatsWriteService');
  }

  private meta(req: ChatsReq) {
    return buildActorMetadata(req.claims!, req.effective);
  }

  @Post()
  @RequiresPermission('platform.settings.manage')
  async create(
    @Body() body: { category?: string; agentName?: string; endUserName?: string },
    @Req() req: ChatsReq,
  ) {
    const category = str(body?.category);
    const agentName = str(body?.agentName);
    const endUserName = str(body?.endUserName);
    if (!category || !agentName || !endUserName) {
      throw new BadRequestException('category, agentName and endUserName are required');
    }
    return callChats(this.write.createConversationStatus({ category, agentName, endUserName }, this.meta(req)));
  }

  /**
   * PATCH — a partial edit by KEY (names, category, active). `active` rides only when the body says
   * it: proto3 cannot tell "absent" from `false`, so the wire carries an explicit `setActive`
   * marker the service reads — retiring is `{active: false}`, restoring `{active: true}`.
   */
  @Patch(':key')
  @RequiresPermission('platform.settings.manage')
  async update(
    @Param('key') key: string,
    @Body() body: { agentName?: string; endUserName?: string; category?: string; active?: boolean },
    @Req() req: ChatsReq,
  ) {
    const hasActive = typeof body?.active === 'boolean';
    return callChats(
      this.write.updateConversationStatus(
        {
          key,
          agentName: str(body?.agentName),
          endUserName: str(body?.endUserName),
          category: str(body?.category),
          setActive: hasActive,
          active: hasActive ? (body!.active as boolean) : false,
        },
        this.meta(req),
      ),
    );
  }
}

/** A trimmed string, or `''` for anything that is not one — the wire's "unchanged". */
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
