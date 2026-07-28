import {
  Body,
  Controller,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Post,
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
import { toMacroActionsWire } from './wire';

interface MacroWire {
  id: string;
}
interface MacroListWire {
  macros: unknown[];
}
interface ConversationWire {
  id: string;
}
interface ChatsReadGrpc {
  listMacros(d: Record<string, unknown>, md?: unknown): Observable<MacroListWire>;
}
interface ChatsWriteGrpc {
  defineMacro(d: Record<string, unknown>, md?: unknown): Observable<MacroWire>;
  applyMacro(d: Record<string, unknown>, md?: unknown): Observable<ConversationWire>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

/**
 * Macros REST edge (feature 013, US2 — roadmap 4.5).
 *
 * Two different permissions on purpose: **authoring** a macro is a configuration task
 * (`crm.templates.manage`), **applying** one is an everyday action (`crm.macros.use`). The service
 * additionally re-checks the permission of every action inside the bundle, so applying can never be
 * a way around a permission the caller lacks.
 *
 * Action types are mapped **fail-closed** by `toMacroActionsWire` — an unknown type is a 400 at the
 * edge, before any RPC (the feature-012 Track-B lesson: never let an unrecognised enum resolve to a
 * real mutation).
 */
@Controller()
export class MacrosController implements OnModuleInit {
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

  @Get('macros')
  @RequiresPermission('crm.templates.manage')
  async list(@Req() req: ChatsReq) {
    return callChats(this.read.listMacros({}, this.meta(req)));
  }

  @Post('macros')
  @RequiresPermission('crm.templates.manage')
  async define(
    @Body() body: { name?: string; actions?: { type?: string; value?: string }[] },
    @Req() req: ChatsReq,
  ) {
    // Throws 400 before the RPC when any action type/value is not recognised.
    const actions = toMacroActionsWire(body?.actions);
    return callChats(
      this.write.defineMacro({ name: (body?.name ?? '').trim(), actions }, this.meta(req)),
    );
  }

  @Post('conversations/:id/macros/:macroId')
  @RequiresPermission('crm.macros.use')
  async apply(
    @Param('id') id: string,
    @Param('macroId') macroId: string,
    @Req() req: ChatsReq,
  ) {
    return callChats(
      this.write.applyMacro({ conversationId: id, macroId }, this.meta(req)),
    );
  }
}
