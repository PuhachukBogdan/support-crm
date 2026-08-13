import {
  BadRequestException,
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
/** What `ListOperatorsByAuthUsers` answers: the translation, plus the availability that rides it. */
interface ResolvedOperatorWire {
  operatorId?: string;
  authUserId?: string;
  /** The proto enum as a number — decoded to a word here, the same closed set the presence edge uses. */
  state?: number | string;
  blockedChannels?: string[];
}
interface ResolvedOperatorsWire {
  operators?: ResolvedOperatorWire[];
}
interface UsersReadGrpc {
  getPlayer(d: Record<string, unknown>, md?: unknown): Observable<PlayerWire>;
  listPlayersByBrand(d: Record<string, unknown>, md?: unknown): Observable<PlayerPageWire>;
  getOperator(d: Record<string, unknown>, md?: unknown): Observable<OperatorWire>;
  listOperatorsByAuthUsers(
    d: Record<string, unknown>,
    md?: unknown,
  ): Observable<ResolvedOperatorsWire>;
}

/**
 * ⓘ W35's notes routes are deliberately NOT here. This file is feature 018's READ edge and FR-027 is a
 * property of it — `tests/users-read/no-outbound.spec.ts` asserts every verb in this file is `Get`, and
 * it caught the first draft of the notes POST on the root run. The notes surface lives in
 * `notes.controller.ts`, which shares the client and the actor metadata and claims no such property.
 */

/**
 * The proto's `PresenceState` as words. Mirrors the presence edge's own decoder — the closed set is
 * `online · transfers_only · away · offline`, and an unrecognised number decodes to `offline`
 * (fail-closed: an unknown state must never read as "available to take work").
 */
const PRESENCE_STATE_WORD: Readonly<Record<string, string>> = {
  '0': 'offline',
  '1': 'online',
  '2': 'transfers_only',
  '3': 'away',
  '4': 'offline',
  PRESENCE_STATE_UNSPECIFIED: 'offline',
  PRESENCE_STATE_ONLINE: 'online',
  PRESENCE_STATE_TRANSFERS_ONLY: 'transfers_only',
  PRESENCE_STATE_AWAY: 'away',
  PRESENCE_STATE_OFFLINE: 'offline',
};

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
  /**
   * ⭐ Q34's answer, made askable (2026-08-06). The directory now has its OWN key — VIP support, AM,
   * Shift AM and teamlead hold it; a line agent does not, and reaches a customer through the ticket
   * they are handling. Previously the entitlement was implicit in a tier comparison inside `users`,
   * which no rail entry could ask about, so the screen was hidden from people who were allowed it.
   *
   * ⚠️ The tier guard in `users` STAYS: it refuses a bulk contact read on its own authority
   * (SEC-AP2), and this key is the door, not the only lock.
   */
  @RequiresPermission('crm.customers.browse')
  async listPlayers(
    @Query() query: Record<string, unknown>,
    @Req() req: PlayerReq,
  ): Promise<{ players: Record<string, unknown>[]; nextPageToken: string }> {
    const { brandId, pageSize, pageToken, playerIdPrefix } = parseListQuery(query);
    // Same projection as the single read — a masked field must not be blanked on one route and absent
    // on the other, or the page and the card would disagree about the same record.
    return toPlayerPageResponse(
      await callUploads(
        this.users.listPlayersByBrand(
          { brandId, pageSize, pageToken, playerIdPrefix },
          this.meta(req),
        ),
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

  /**
   * ⭐ 2026-08-10 — AUTH user ids → assignable operator profiles, for the ticket window's Assignee
   * chooser. The operator, on the shipped screen: *«я всё ещё не вижу возможности менять поля типа
   * бренд, ассайни»* — Assignee rendered a raw `Operator.id` and offered only «take it», so
   * reassigning to a named colleague had no control at all.
   *
   * ── Why an EDGE and not a new rpc ────────────────────────────────────────────────────────────────
   * `UsersReadService.ListOperatorsByAuthUsers` has answered exactly this since feature 024 and was
   * reachable from nowhere outside the cluster — the same shape as the `groupId` field the assignment
   * route forgot to forward, and the same conclusion: *a contract with no caller is indistinguishable
   * from an unbuilt one.* Nothing new is invented here; a path is put in front of what exists.
   *
   * ── The gate is the rpc's OWN key, deliberately unchanged ────────────────────────────────────────
   * `crm.conversation.assign`. The rpc's comment states the rule this route must not break: *"the
   * caller forwards its own credentials unchanged; calling as a system actor would launder the
   * permission."* Matching the key exactly means the edge cannot widen the answer — and the owning
   * service re-checks regardless, so this is the door, not the lock.
   *
   * ⓘ Staffing facts only: an operator id, a display-name-less profile reference, presence and the
   * channels switched off. **No customer data exists in this answer to mask** (the rpc's own words),
   * which is why there is no projection step here as there is on every player route above. NAMES are
   * not here either — the browser already holds them from the staff list it joined this against.
   *
   * ⚠️ `authUserIds` is REQUIRED and capped. Absent, the honest answer is a 400, not "everyone": the
   * rpc takes a list and there is no "all operators" question in the contract, so defaulting would
   * mean inventing one here — in the tier that is forbidden to hold business logic.
   */
  @Get('operators')
  @RequiresPermission('crm.conversation.assign')
  async listOperators(
    @Query('authUserIds') authUserIds: string | undefined,
    @Req() req: PlayerReq,
  ): Promise<{ operators: { operatorId: string; authUserId: string; state: string; blockedChannels: string[] }[] }> {
    const asked = (authUserIds ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (asked.length === 0) throw new BadRequestException('authUserIds is required');
    // The staff list this is joined against is itself capped at 100 by its caller; the same bound is
    // restated here so a hand-made request cannot turn one translation into an unbounded one.
    if (asked.length > 200) throw new BadRequestException('authUserIds: at most 200 per request');

    const res = await callUploads(
      this.users.listOperatorsByAuthUsers({ authUserIds: asked }, this.meta(req)),
    );
    // The wire is RESTATED rather than spread — a field added to the rpc does not silently reach the
    // browser (the rule `me/operator` states one file over).
    return {
      operators: (res?.operators ?? []).map((o) => ({
        operatorId: o.operatorId ?? '',
        authUserId: o.authUserId ?? '',
        state: PRESENCE_STATE_WORD[String(o.state ?? '')] ?? 'offline',
        blockedChannels: o.blockedChannels ?? [],
      })),
    };
  }
}
