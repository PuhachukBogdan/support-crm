import { BadRequestException, Controller, Get, Inject, OnModuleInit, Query, Req } from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import type { Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { CHATS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { buildActorMetadata } from './actor-metadata';
import { callChats } from './rpc';

interface SnapshotWire {
  createdToday?: number;
  openNow?: number;
  avgFirstReplySeconds?: number;
  firstReplyCount?: number;
  byChannel?: unknown[];
  byAgent?: unknown[];
  pendingByAgent?: unknown[];
  volumeByDay?: unknown[];
}
interface AnalyticsGrpc {
  getAnalyticsSnapshot(d: { days: number }, md?: unknown): Observable<SnapshotWire>;
}

type ChatsReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

/**
 * ⭐ W20 (roadmap 11.1 minimum) — `GET /analytics/snapshot`: the dashboard's one read. Thin proxy;
 * `analytics.dashboard.view` at both tiers; aggregates only on the wire.
 */
@Controller('analytics')
export class AnalyticsController implements OnModuleInit {
  private read!: AnalyticsGrpc;

  constructor(@Inject(CHATS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.read = this.client.getService<AnalyticsGrpc>('ChatsReadService');
  }

  @Get('snapshot')
  @RequiresPermission('analytics.dashboard.view')
  async snapshot(@Query('days') days: string | undefined, @Req() req: ChatsReq) {
    const n = days === undefined ? 0 : Number.parseInt(days, 10);
    if (days !== undefined && (!Number.isInteger(n) || n <= 0)) {
      throw new BadRequestException('days must be a positive integer');
    }
    const res = await callChats(
      this.read.getAnalyticsSnapshot({ days: n }, buildActorMetadata(req.claims!, req.effective)),
    );
    // proto3 omits zeroes and empty lists; the screen must read absences as ZEROES, not crashes.
    return {
      createdToday: res.createdToday ?? 0,
      openNow: res.openNow ?? 0,
      avgFirstReplySeconds: res.avgFirstReplySeconds ?? -1,
      firstReplyCount: res.firstReplyCount ?? 0,
      byChannel: res.byChannel ?? [],
      byAgent: res.byAgent ?? [],
      pendingByAgent: res.pendingByAgent ?? [],
      volumeByDay: res.volumeByDay ?? [],
    };
  }
}
