import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Patch,
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
import { toAutomationDefinitionWire, type AutomationDefinitionInput } from './wire';

interface AutomationWire {
  id: string;
}
interface AutomationListWire {
  automations: unknown[];
  nextPageToken: string;
}
interface AutomationRunListWire {
  runs: unknown[];
  nextPageToken: string;
}
interface AckWire {
  ok: boolean;
}

interface ChatsReadGrpc {
  listAutomations(d: Record<string, unknown>, md?: unknown): Observable<AutomationListWire>;
  listAutomationRuns(d: Record<string, unknown>, md?: unknown): Observable<AutomationRunListWire>;
}
interface ChatsWriteGrpc {
  createAutomation(d: Record<string, unknown>, md?: unknown): Observable<AutomationWire>;
  updateAutomation(d: Record<string, unknown>, md?: unknown): Observable<AutomationWire>;
  deleteAutomation(d: Record<string, unknown>, md?: unknown): Observable<AckWire>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

interface CreateBody {
  name?: string;
  definition?: AutomationDefinitionInput;
  position?: number;
  active?: boolean;
}
interface UpdateBody extends CreateBody {
  name?: string;
}

/**
 * Automation rules REST edge (feature 014, US1 — roadmap 4.6).
 *
 * One permission for the whole surface: `crm.automations.manage`. That is deliberately supervisory —
 * whoever can author rules decides what the system does by itself, and a rule runs with its author's
 * authority (FR-023). The service re-checks the same key, plus each action's own permission against
 * the author at run time.
 *
 * Definitions are validated **at the edge** by `toAutomationDefinitionWire`: an unrecognised trigger,
 * condition field/op or action type is a 400 before any RPC. That matters more here than for a macro —
 * a macro misfires once when someone clicks it, whereas a rule with a guessed trigger would keep
 * misfiring on every future event with nobody watching.
 *
 * The author is NOT accepted from the body; the service takes it from validated claims.
 */
@Controller()
export class AutomationsController implements OnModuleInit {
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

  @Get('automations')
  @RequiresPermission('crm.automations.manage')
  async list(
    @Req() req: ChatsReq,
    @Query('pageToken') pageToken?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return callChats(
      this.read.listAutomations(
        { pageToken: pageToken ?? '', pageSize: toInt(pageSize) },
        this.meta(req),
      ),
    );
  }

  @Get('automations/runs')
  @RequiresPermission('crm.automations.manage')
  async runs(
    @Req() req: ChatsReq,
    @Query('automationId') automationId?: string,
    @Query('conversationId') conversationId?: string,
    @Query('pageToken') pageToken?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return callChats(
      this.read.listAutomationRuns(
        {
          automationId: automationId ?? '',
          conversationId: conversationId ?? '',
          pageToken: pageToken ?? '',
          pageSize: toInt(pageSize),
        },
        this.meta(req),
      ),
    );
  }

  @Post('automations')
  @RequiresPermission('crm.automations.manage')
  async create(@Body() body: CreateBody, @Req() req: ChatsReq) {
    // Throws 400 before the RPC on any unrecognised trigger / field / op / action.
    const definition = toAutomationDefinitionWire(body?.definition);
    return callChats(
      this.write.createAutomation(
        {
          name: (body?.name ?? '').trim(),
          definition,
          position: Math.max(0, Math.trunc(Number(body?.position ?? 0) || 0)),
          active: body?.active ?? true,
        },
        this.meta(req),
      ),
    );
  }

  @Patch('automations/:id')
  @RequiresPermission('crm.automations.manage')
  async update(@Param('id') id: string, @Body() body: UpdateBody, @Req() req: ChatsReq) {
    // Presence flags travel explicitly: through proto-loader an absent scalar is indistinguishable
    // from ""/0/false, so "disable this rule" and "clear its name" would otherwise look identical.
    const hasName = typeof body?.name === 'string';
    const hasDefinition = body?.definition !== undefined;
    const hasPosition = body?.position !== undefined;
    const hasActive = body?.active !== undefined;
    return callChats(
      this.write.updateAutomation(
        {
          id,
          name: hasName ? body.name!.trim() : '',
          hasName,
          definition: hasDefinition ? toAutomationDefinitionWire(body.definition) : undefined,
          hasDefinition,
          position: hasPosition ? Math.max(0, Math.trunc(Number(body.position) || 0)) : 0,
          hasPosition,
          active: hasActive ? !!body.active : false,
          hasActive,
        },
        this.meta(req),
      ),
    );
  }

  @Delete('automations/:id')
  @RequiresPermission('crm.automations.manage')
  async remove(@Param('id') id: string, @Req() req: ChatsReq) {
    return callChats(this.write.deleteAutomation({ id }, this.meta(req)));
  }
}

/** A query-string page size; the service clamps it (100 max, 50 default). */
function toInt(raw?: string): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}
