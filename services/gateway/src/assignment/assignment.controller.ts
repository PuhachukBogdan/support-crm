import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  OnModuleInit,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import type { Request } from 'express';
import type { Metadata } from '@grpc/grpc-js';
import { USERS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission, ResolvesPermissions } from '../security/requires-permission.decorator';
import { buildActorMetadata } from '../chats/actor-metadata';

/**
 * Player ↔ AM assignment edge (feature 026, roadmap 5.7). A thin proxy.
 *
 * ⚠️ **No cache**, and for a sharper reason than usual: an attachment decides what a person may
 * **read**. A stale answer here is an access-control defect, not a freshness one — the same rule
 * presence follows, arrived at from the other direction.
 *
 * ⚠️ **Every call carries the actor context.** Feature 025's live run found this edge's sibling
 * forwarding none at all: it compiled, every unit test passed, and on the real stack the service had
 * no idea who was asking. A fake client does not care what metadata it is handed.
 *
 * The gateway does no business logic (Principle VIII): it forwards, validates shape, maps a status.
 */

const ASSIGN_KEY = 'users.player.assign';
const STAFF_LIST = 'users.list.view';
const CONTACT_VIEW = 'crm.contact.view';

/**
 * ⚠️ Compared by NAME as well as by tag. `grpcClientOptions` loads protos with `enums: String`, so a
 * response carries `"ASSIGNMENT_STATUS_OK"` and not `1`. Feature 025 lost a live iteration to
 * exactly this: writes kept working while reads broke, so every unit test stayed green.
 */
const is = (raw: unknown, tag: number, name: string): boolean => raw === tag || raw === name;

const S = {
  OK: [1, 'ASSIGNMENT_STATUS_OK'] as const,
  UNCHANGED: [2, 'ASSIGNMENT_STATUS_UNCHANGED'] as const,
  FORBIDDEN: [3, 'ASSIGNMENT_STATUS_FORBIDDEN'] as const,
  NO_SUCH_PLAYER: [4, 'ASSIGNMENT_STATUS_NO_SUCH_PLAYER'] as const,
  NO_SUCH_MANAGER: [5, 'ASSIGNMENT_STATUS_NO_SUCH_MANAGER'] as const,
  ALREADY_ASSIGNED: [6, 'ASSIGNMENT_STATUS_ALREADY_ASSIGNED'] as const,
};

interface AssignmentWire {
  brandId?: string;
  playerId?: string;
  amAuthUserId?: string;
  assignedBy?: string;
  startedAt?: string;
  endedAt?: string;
}

interface ResponseWire {
  status?: number | string;
  assignment?: AssignmentWire;
}

interface AssignmentGrpc {
  assignPlayer(
    d: { brandId: string; playerId: string; amAuthUserId: string },
    md: Metadata,
  ): Observable<ResponseWire>;
  unassignPlayer(d: { brandId: string; playerId: string }, md: Metadata): Observable<ResponseWire>;
}

interface AssignmentReadGrpc {
  getPlayerAssignment(d: { brandId: string; playerId: string }, md: Metadata): Observable<AssignmentWire>;
  listAssignedPlayers(
    d: { amAuthUserId: string; pageSize: number; pageToken: string },
    md: Metadata,
  ): Observable<{ assignments?: AssignmentWire[]; nextPageToken?: string }>;
}

const toJson = (a?: AssignmentWire) =>
  a && a.amAuthUserId
    ? {
        brandId: a.brandId ?? '',
        playerId: a.playerId ?? '',
        amAuthUserId: a.amAuthUserId,
        assignedBy: a.assignedBy ?? '',
        startedAt: a.startedAt ?? null,
        endedAt: a.endedAt || null,
      }
    : null;

/**
 * ⚠️ NO `api` PREFIX, and this is a CORRECTION.
 *
 * Feature 025 shipped `@Controller('api')` on the presence edge, and feature 026 copied it. Every
 * other controller in this gateway — 25 of them — mounts at the bare path: `/auth/…`, `/players/…`,
 * `/conversations/…`, `/admin/access/…`. Two prefixes on one REST surface is the kind of split that
 * looks like a convention to whoever meets it second and is a coin-flip to everybody else.
 *
 * Found on the live run of 026, and only there: every unit test constructs the controller directly
 * and never sees a URL, so the routing table is invisible to Track A by construction. Corrected in
 * both places at once rather than leaving one wrong — nothing consumes either surface yet (the
 * frontend is Phase 9), so the cost of fixing it now is zero and it only rises.
 */
@Controller()
export class AssignmentController implements OnModuleInit {
  private writes!: AssignmentGrpc;
  private reads!: AssignmentReadGrpc;

  constructor(@Inject(USERS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.writes = this.client.getService<AssignmentGrpc>('PlayerAssignmentService');
    this.reads = this.client.getService<AssignmentReadGrpc>('UsersReadService');
  }

  @Get('players/:brandId/:playerId/assignment')
  @RequiresPermission(CONTACT_VIEW)
  async whoLooksAfter(
    @Req() req: Request,
    @Param('brandId') brandId: string,
    @Param('playerId') playerId: string,
  ) {
    this.session(req);
    // ⚠️ `null` means NOBODY looks after this player — a real and common state, not a 404. A 404 here
    // would say "no such player", which is a different fact and would send somebody hunting.
    return { assignment: toJson(await firstValueFrom(this.reads.getPlayerAssignment({ brandId, playerId }, this.meta(req)))) };
  }

  @Get('me/players')
  @ResolvesPermissions()
  async myPlayers(@Req() req: Request, @Query('pageSize') pageSize?: string, @Query('pageToken') pageToken?: string) {
    this.session(req);
    return this.page('', pageSize, pageToken, req);
  }

  @Get('operators/:authUserId/players')
  @RequiresPermission(STAFF_LIST)
  async theirPlayers(
    @Req() req: Request,
    @Param('authUserId') authUserId: string,
    @Query('pageSize') pageSize?: string,
    @Query('pageToken') pageToken?: string,
  ) {
    this.session(req);
    return this.page(authUserId, pageSize, pageToken, req);
  }

  @Post('players/:brandId/:playerId/assignment')
  @RequiresPermission(ASSIGN_KEY)
  async assign(
    @Req() req: Request,
    @Param('brandId') brandId: string,
    @Param('playerId') playerId: string,
    @Body() body: { amAuthUserId?: string },
  ) {
    this.session(req);
    const res = await firstValueFrom(
      // An absent manager means ME. Self-assignment is the requirement, so it is the default.
      this.writes.assignPlayer(
        { brandId, playerId, amAuthUserId: (body?.amAuthUserId ?? '').trim() },
        this.meta(req),
      ),
    );
    return this.finish(res);
  }

  @Delete('players/:brandId/:playerId/assignment')
  @RequiresPermission(ASSIGN_KEY)
  async unassign(
    @Req() req: Request,
    @Param('brandId') brandId: string,
    @Param('playerId') playerId: string,
  ) {
    this.session(req);
    return this.finish(await firstValueFrom(this.writes.unassignPlayer({ brandId, playerId }, this.meta(req))));
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────────────────

  private async page(subject: string, pageSize: string | undefined, pageToken: string | undefined, req: Request) {
    const size = Number(pageSize ?? 0);
    if (pageSize !== undefined && (!Number.isFinite(size) || size < 0)) {
      throw new BadRequestException('pageSize must be a non-negative number');
    }
    const res = await firstValueFrom(
      this.reads.listAssignedPlayers(
        { amAuthUserId: subject, pageSize: size, pageToken: pageToken ?? '' },
        this.meta(req),
      ),
    );
    return {
      players: (res?.assignments ?? []).map(toJson).filter(Boolean),
      nextPageToken: res?.nextPageToken || null,
    };
  }

  private meta(req: Request): Metadata {
    const r = req as Request & { claims?: RequestClaims; effective?: unknown };
    return buildActorMetadata(r.claims!, r.effective as never);
  }

  private session(req: Request): RequestClaims {
    const claims = (req as Request & { claims?: RequestClaims }).claims;
    if (!claims) throw new ForbiddenException();
    return claims;
  }

  /** One mapping per distinguishable answer — never one flat refusal for four different problems. */
  private finish(res: ResponseWire) {
    if (is(res?.status, ...S.FORBIDDEN)) throw new ForbiddenException();
    if (is(res?.status, ...S.NO_SUCH_PLAYER)) throw new NotFoundException('no such player');
    // Deliberately distinct from the player 404: "that manager has left" sends an administrator
    // somewhere else entirely.
    if (is(res?.status, ...S.NO_SUCH_MANAGER)) throw new NotFoundException('no such manager');
    // ⭐ 409, not 400. Somebody else holds this player; the request was well-formed and the state
    // said no. A caller who means to move the player unassigns first, deliberately.
    if (is(res?.status, ...S.ALREADY_ASSIGNED)) throw new ConflictException('already assigned');
    return {
      // `changed: false` is surfaced rather than swallowed — one path writes an audit entry and the
      // other must not, and that difference has to be observable from outside.
      changed: is(res?.status, ...S.OK),
      assignment: toJson(res?.assignment),
    };
  }
}
