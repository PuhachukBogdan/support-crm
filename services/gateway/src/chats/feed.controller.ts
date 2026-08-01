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
  /** Feature 022 (roadmap 4.13) — the card's contact facts, one grouped read, no paging. */
  getPlayerContactSummary(d: Record<string, unknown>, md?: unknown): Observable<unknown>;
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
    @Query() q: { brandId?: string; pageToken?: string; pageSize?: string },
    @Req() req: ChatsReq,
  ) {
    const md = buildActorMetadata(req.claims!, req.effective);
    // Feature 020: which player's feed. Without the brand the platform id names two customers, and
    // merging them is the defect this feature removed — so the owning service refuses, and the edge
    // forwards the brand rather than inventing one.
    return callChats(
      this.read.getPlayerFeed(
        {
          playerId,
          brandId: q.brandId ?? '',
          pageToken: q.pageToken ?? '',
          pageSize: q.pageSize ? Number(q.pageSize) : 0,
        },
        md,
      ),
    );
  }

  /**
   * Feature 022 (roadmap 4.13) — `GET /players/:playerId/contact-summary?brandId=…`
   *
   * The card's "when did we last talk to this customer, and on which channels". A separate route rather
   * than a field on the feed: an aggregate attached to a paged response is recomputed on every page and
   * invites a caller to read page 1 to learn a total (FR-013).
   *
   * `brandId` is forwarded and NOT defaulted — the owning service refuses a request without one, because
   * a platform id alone names two customers (feature 020 / roadmap 5.2). The edge does not invent an
   * identity to make a call succeed.
   *
   * ⚠️ The route carries `@RequiresPermission`, which is also what makes the gateway resolve and forward
   * the caller's permission set. Feature 016's live-only defect was a route with no permission metadata:
   * the gateway forwarded an EMPTY `x-actor-permissions` and the owning service correctly refused
   * everything. `contact-summary.spec.ts` asserts the metadata is present rather than assuming it.
   */
  @Get('contact-summary')
  @RequiresPermission('crm.inbox.view')
  async contactSummary(
    @Param('playerId') playerId: string,
    @Query() q: { brandId?: string },
    @Req() req: ChatsReq,
  ) {
    const md = buildActorMetadata(req.claims!, req.effective);
    return callChats(
      this.read.getPlayerContactSummary({ playerId, brandId: q.brandId ?? '' }, md),
    );
  }
}
