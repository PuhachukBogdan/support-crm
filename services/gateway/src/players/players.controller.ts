import { Controller, Get, Inject, OnModuleInit, Param, Query, Req } from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { type Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import { USERS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { buildActorMetadata } from '../chats/actor-metadata';
import { callUploads } from '../uploads/rpc';
import { parseListQuery, parseGetQuery, toPlayerResponse, toPlayerPageResponse } from './wire';

interface PlayerWire {
  playerId: string;
  accountId: string;
  brandIds: string[];
  vip: boolean;
  segment: string;
  amNotes: string;
  customAttributesJson: string;
  preferencesJson: string;
  portfolioJson: string;
}
interface PlayerPageWire {
  players?: PlayerWire[];
  nextPageToken?: string;
}
interface OperatorWire {
  operatorId: string;
  accountId: string;
  displayName: string;
  active: boolean;
}
interface UsersReadGrpc {
  getPlayer(d: Record<string, unknown>, md?: unknown): Observable<PlayerWire>;
  listPlayersByBrand(d: Record<string, unknown>, md?: unknown): Observable<PlayerPageWire>;
  getOperator(d: Record<string, unknown>, md?: unknown): Observable<OperatorWire>;
}

type PlayerReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

/**
 * The players + operators read edge (feature 018, roadmap 5.1).
 *
 * ── Why this exists at all, since the customer card is a later point ────────────────────────────
 * Two-tier authorization is a NON-NEGOTIABLE principle, and a second tier that nothing exercises is a
 * claim rather than a control. Beyond that, the Definition of Done requires a live validation run and
 * nothing in the product calls these three operations — so without an edge the only way to reach them
 * live is a hand-driven internal tool, which proves the service answers and proves nothing about the
 * tier in front of it. No screen, no write, no fourth route.
 *
 * ── Every route carries permission metadata, and the required key is a CONSTANT here ────────────
 * ⚠️ Not decoration: the guard populates `req.effective` only for routes carrying permission metadata,
 * and `buildActorMetadata` reads exactly that to fill the forwarded headers. Feature 016's Track B found
 * this the hard way — two GET routes carried none, forwarded an EMPTY permission set, and the owning
 * service correctly refused every read of a file the caller owned. Both tiers right, the wire between
 * them wrong. A static key is possible here (unlike exports, where it depended on a path parameter).
 *
 * ── This edge forwards two headers no route in the product forwarded before ──────────────────────
 * Passing `req.effective` supplies `x-actor-effective-role` (the masking input — the *previewed* role
 * under view-as) and `x-is-preview` (the audit entry's marker, which no route has ever sent, so every
 * entry in the product has claimed no preview was active regardless of the truth).
 */
@Controller()
export class PlayersController implements OnModuleInit {
  private users!: UsersReadGrpc;

  constructor(@Inject(USERS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    // The EXISTING users client (the exports edge already consumes it). A second registration would open
    // a second connection to the same service for no reason.
    this.users = this.client.getService<UsersReadGrpc>('UsersReadService');
  }

  private meta(req: PlayerReq) {
    return buildActorMetadata(req.claims!, req.effective);
  }

  /**
   * One customer record, masked to the caller's tier by the owning service.
   *
   * The response goes through `toPlayerResponse`, which drops default-valued fields so a withheld one
   * is ABSENT rather than blanked (011's FR-014). Passing the decoded message straight through — as
   * this route did until 2026-07-29 — carried every key for every role. See `wire.ts` for why the
   * omission keys off the value and not off the caller's clearance.
   */
  @Get('players/:playerId')
  @RequiresPermission('crm.contact.view')
  async getPlayer(
    @Param('playerId') playerId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: PlayerReq,
  ): Promise<Record<string, unknown>> {
    // ⚠️ The brand is REQUIRED (feature 020): a platform id alone names two customers, not one, so
    // there is no correct record to return — only a lucky one. Refused here, before the call, for the
    // same reason the owning service refuses it: the ambiguity is in the request, not in the data.
    const brandId = parseGetQuery(query);
    return toPlayerResponse(
      await callUploads(this.users.getPlayer({ playerId, brandId }, this.meta(req))),
    );
  }

  /**
   * One page of a brand's customers.
   *
   * `brandId` is required and an unrecognised query parameter is a 400 — see `wire.ts`. The bulk-read
   * guard lives in the owning service and runs before any record is read, so a role that may not
   * bulk-read contacts is refused here as a 403 with nothing read and nothing recorded.
   */
  @Get('players')
  @RequiresPermission('crm.contact.view')
  async listPlayers(
    @Query() query: Record<string, unknown>,
    @Req() req: PlayerReq,
  ): Promise<{ players: Record<string, unknown>[]; nextPageToken: string }> {
    const { brandId, pageSize, pageToken } = parseListQuery(query);
    // Same projection as the single read — a masked field must not be blanked on one route and absent
    // on the other, or the page and the card would disagree about the same record.
    return toPlayerPageResponse(
      await callUploads(
        this.users.listPlayersByBrand({ brandId, pageSize, pageToken }, this.meta(req)),
      ),
    );
  }

  /**
   * One staff record.
   *
   * Gated by the inbox permission rather than the contact one: the visibility policy classifies CUSTOMER
   * fields, and resolving who a conversation is assigned to is part of using the inbox. Reusing the
   * contact key would make one key mean two different things (research R8).
   */
  @Get('operators/:operatorId')
  @RequiresPermission('crm.inbox.view')
  async getOperator(
    @Param('operatorId') operatorId: string,
    @Req() req: PlayerReq,
  ): Promise<OperatorWire> {
    return callUploads(this.users.getOperator({ operatorId }, this.meta(req)));
  }
}
