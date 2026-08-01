import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  NotFoundException,
  OnModuleInit,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import type { Request } from 'express';
import type { Metadata } from '@grpc/grpc-js';
import {
  decodeWireCause,
  decodeWireState,
  isPresenceState,
  PRESENCE_STATES,
  type PresenceState,
} from '@crm/common';
import { USERS_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission, ResolvesPermissions } from '../security/requires-permission.decorator';
import { buildActorMetadata } from '../chats/actor-metadata';

/**
 * Presence edge (feature 025, roadmap 5.9). A thin proxy over the users presence surface.
 *
 * ── ⚠️ THERE IS NO CACHE HERE, AND THAT IS THE POINT (FR-032) ───────────────────────────────────
 * The obvious next step for a read this hot is to wrap it the way `EffectivePermsCache` wraps
 * permissions — 30 seconds, explicit invalidation. Do not. A stale "available" pushes a LIVE
 * customer at somebody who has gone home; the failure lands on a person waiting for an answer, not
 * on a slightly out-of-date screen. The permissions cache is the precedent *and* the warning: it
 * works only because every privilege change invalidates it explicitly, and presence changes far more
 * often than privileges do.
 *
 * If a cache is ever added it needs invalidation on every transition, including the ones the SWEEP
 * writes — which nothing at this edge can observe. `presence.spec.ts` asserts no cache wrapper is
 * applied to any route in this file.
 *
 * ── No WebSocket either ─────────────────────────────────────────────────────────────────────────
 * Real-time transport is roadmap 7.1. The heartbeat rides this ordinary HTTP edge, and the gateway's
 * WebSocket keeps its single `ping` handler until then.
 *
 * The gateway does no business logic (Principle VIII): it forwards, validates shape, and maps a
 * status to HTTP.
 */

const PRESENCE_MANAGE = 'users.presence.manage';
const STAFF_LIST = 'users.list.view';
const SETTINGS_MANAGE = 'platform.settings.manage';

/** Wire numbering, mirroring the proto. The service is the authority; this is the edge's decoder. */
const STATE_WIRE: Readonly<Record<PresenceState, number>> = {
  online: 1,
  transfers_only: 2,
  away: 3,
  offline: 4,
};
/**
 * ⚠️ A STATUS arrives as a NAME too, for the same reason states do (`enums: String`). Comparing it to
 * a number silently matched nothing, so every refusal looked like a success with an empty body — the
 * live-run defect that made a supervisor override "work" while changing nothing.
 */
const statusIs = (raw: unknown, tag: number, name: string): boolean =>
  raw === tag || raw === name;

const STATUS = {
  OK: [1, 'PRESENCE_STATUS_OK'],
  UNCHANGED: [2, 'PRESENCE_STATUS_UNCHANGED'],
  FORBIDDEN: [3, 'PRESENCE_STATUS_FORBIDDEN'],
  NO_SUCH_OPERATOR: [4, 'PRESENCE_STATUS_NO_SUCH_OPERATOR'],
  UNKNOWN_LABEL: [5, 'PRESENCE_STATUS_UNKNOWN_LABEL'],
  NAME_TAKEN: [6, 'PRESENCE_STATUS_NAME_TAKEN'],
} as const;

const is = (raw: unknown, k: keyof typeof STATUS): boolean =>
  statusIs(raw, STATUS[k][0] as number, STATUS[k][1] as string);

interface PresenceWire {
  authUserId?: string;
  state?: number | string;
  lastCause?: number | string;
  lastSeenAt?: string;
  labelId?: string;
  blockedChannels?: string[];
  operatorActive?: boolean;
}

interface SetResponseWire {
  status?: number | string;
  presence?: PresenceWire;
}

interface LabelWire {
  id?: string;
  name?: string;
  state?: number | string;
}

/**
 * ⚠️ EVERY method takes `Metadata`, and that is not boilerplate.
 *
 * The actor context — account, user, effective role, resolved permissions — rides gRPC METADATA, not
 * message fields (feature 011). The first draft of this file omitted it entirely: every call still
 * compiled, every unit test still passed, and on the live stack `users` received no account and no
 * user, so `GET /api/presence/me` answered `offline` for somebody who was online and the supervisor
 * override answered nothing at all. Found by Track B, invisible to Track A — a fake client does not
 * care what metadata it is handed.
 */
interface PresenceGrpc {
  setOwnPresence(d: { state: number; labelId?: string }, md: Metadata): Observable<SetResponseWire>;
  heartbeat(d: Record<string, never>, md: Metadata): Observable<SetResponseWire>;
  setChannelAvailability(
    d: { channel: string; available: boolean },
    md: Metadata,
  ): Observable<SetResponseWire>;
  setOperatorPresence(
    d: { authUserId: string; state: number },
    md: Metadata,
  ): Observable<SetResponseWire>;
  listPresenceLabels(d: Record<string, never>, md: Metadata): Observable<{ labels?: LabelWire[] }>;
  upsertPresenceLabel(
    d: { id?: string; name: string; state: number },
    md: Metadata,
  ): Observable<{ status?: number | string; label?: LabelWire }>;
  deletePresenceLabel(d: { id: string }, md: Metadata): Observable<{ status?: number | string }>;
}

interface PresenceReadGrpc {
  getOperatorPresence(d: { authUserId?: string }, md: Metadata): Observable<PresenceWire>;
  listOperatorPresence(
    d: { authUserIds: string[] },
    md: Metadata,
  ): Observable<{ presence?: PresenceWire[] }>;
}

/** The shape a client sees. Enum NAMES, never wire numbers — a REST client should not know either. */
const toJson = (p?: PresenceWire) =>
  p
    ? {
        authUserId: p.authUserId ?? '',
        // Fail-closed on an unreadable value: `offline` is the answer that declines to route, and
        // the alternative would push a live customer at somebody nobody could account for.
        state: decodeWireState(p.state) ?? 'offline',
        lastCause: decodeWireCause(p.lastCause),
        lastSeenAt: p.lastSeenAt || null,
        labelId: p.labelId || null,
        // ONLY the switched-off channels. An empty array is the normal answer.
        blockedChannels: p.blockedChannels ?? [],
        operatorActive: p.operatorActive === true,
      }
    : null;

@Controller('api')
export class PresenceController implements OnModuleInit {
  private presence!: PresenceGrpc;
  private read!: PresenceReadGrpc;

  constructor(@Inject(USERS_CLIENT) private readonly client: ClientGrpc) {}

  onModuleInit(): void {
    this.presence = this.client.getService<PresenceGrpc>('OperatorPresenceService');
    this.read = this.client.getService<PresenceReadGrpc>('UsersReadService');
  }

  // ── one's own presence: no permission key, because it is a fact about oneself ─────────────────

  @Get('presence/me')
  @ResolvesPermissions()
  async getMine(@Req() req: Request) {
    this.requireSession(req);
    return toJson(await firstValueFrom(this.read.getOperatorPresence({}, this.meta(req))));
  }

  @Put('presence/me')
  @ResolvesPermissions()
  async setMine(@Req() req: Request, @Body() body: { state?: string; labelId?: string }) {
    this.requireSession(req);
    const state = this.decodeState(body?.state);
    const res = await firstValueFrom(
      this.presence.setOwnPresence(
        { state: STATE_WIRE[state], labelId: body?.labelId ?? '' },
        this.meta(req),
      ),
    );
    return this.finish(res);
  }

  @Post('presence/me/heartbeat')
  @ResolvesPermissions()
  async heartbeat(@Req() req: Request) {
    this.requireSession(req);
    return this.finish(await firstValueFrom(this.presence.heartbeat({}, this.meta(req))));
  }

  @Put('presence/me/channels/:channel')
  @ResolvesPermissions()
  async setChannel(
    @Req() req: Request,
    @Param('channel') channel: string,
    @Body() body: { available?: boolean },
  ) {
    this.requireSession(req);
    const name = (channel ?? '').trim();
    if (!name) throw new BadRequestException('channel is required');
    // ⚠️ The channel is NOT validated against a vocabulary, deliberately — this product has none yet
    // (roadmap 4.17 / Phase 6 own it). A key nobody routes to simply switches off a channel nobody
    // routes to, which is why inventing a list here would cost more than it protects (research R8).
    if (typeof body?.available !== 'boolean') {
      throw new BadRequestException('available must be a boolean');
    }
    return this.finish(
      await firstValueFrom(
        this.presence.setChannelAvailability(
          { channel: name, available: body.available },
          this.meta(req),
        ),
      ),
    );
  }

  // ── somebody else's presence ──────────────────────────────────────────────────────────────────

  @Get('presence')
  @RequiresPermission(STAFF_LIST)
  async listPresence(@Req() req: Request, @Query('operatorIds') ids?: string) {
    this.requireSession(req);
    const authUserIds = (ids ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (authUserIds.length === 0) throw new BadRequestException('operatorIds is required');
    const res = await firstValueFrom(this.read.listOperatorPresence({ authUserIds }, this.meta(req)));
    return { presence: (res?.presence ?? []).map(toJson) };
  }

  @Put('operators/:authUserId/presence')
  @RequiresPermission(PRESENCE_MANAGE)
  async setOthers(
    @Req() req: Request,
    @Param('authUserId') authUserId: string,
    @Body() body: { state?: string },
  ) {
    this.requireSession(req);
    const state = this.decodeState(body?.state);
    const res = await firstValueFrom(
      this.presence.setOperatorPresence(
        { authUserId, state: STATE_WIRE[state] },
        this.meta(req),
      ),
    );
    return this.finish(res);
  }

  // ── labels: administrator-editable decoration ─────────────────────────────────────────────────

  @Get('presence/labels')
  @ResolvesPermissions()
  async listLabels(@Req() req: Request) {
    this.requireSession(req);
    const res = await firstValueFrom(this.presence.listPresenceLabels({}, this.meta(req)));
    return {
      labels: (res?.labels ?? []).map((l) => ({
        id: l.id ?? '',
        name: l.name ?? '',
        state: decodeWireState(l.state) ?? 'offline',
      })),
    };
  }

  @Post('presence/labels')
  @RequiresPermission(SETTINGS_MANAGE)
  async upsertLabel(@Req() req: Request, @Body() body: { id?: string; name?: string; state?: string }) {
    this.requireSession(req);
    const name = (body?.name ?? '').trim();
    if (!name) throw new BadRequestException('name is required');
    const state = this.decodeState(body?.state);
    const res = await firstValueFrom(
      this.presence.upsertPresenceLabel(
        { id: body?.id ?? '', name, state: STATE_WIRE[state] },
        this.meta(req),
      ),
    );
    this.throwOnStatus(res?.status);
    return {
      id: res?.label?.id ?? '',
      name: res?.label?.name ?? '',
      state: decodeWireState(res?.label?.state) ?? 'offline',
    };
  }

  @Delete('presence/labels/:id')
  @RequiresPermission(SETTINGS_MANAGE)
  async deleteLabel(@Req() req: Request, @Param('id') id: string) {
    this.requireSession(req);
    const res = await firstValueFrom(this.presence.deletePresenceLabel({ id }, this.meta(req)));
    this.throwOnStatus(res?.status);
    return { deleted: true };
  }

  // ── helpers ───────────────────────────────────────────────────────────────────────────────────

  /** The actor context every downstream call needs. See the note on `PresenceGrpc` above. */
  private meta(req: Request): Metadata {
    const r = req as Request & { claims?: RequestClaims; effective?: unknown };
    return buildActorMetadata(r.claims!, r.effective as never);
  }

  private requireSession(req: Request): RequestClaims {
    const claims = (req as Request & { claims?: RequestClaims }).claims;
    if (!claims) throw new ForbiddenException();
    return claims;
  }

  /**
   * A REST client sends a NAME, never a wire number.
   *
   * ⚠️ Refused rather than defaulted. An unrecognised state that fell through to `online` would
   * WIDEN availability, and the widening direction is the one that pushes live customers at absent
   * agents — the fail-closed rule this edge already applies to export scopes and chats actions,
   * where dropping an unknown filter widens the result set.
   */
  private decodeState(raw: unknown): PresenceState {
    if (typeof raw === 'string' && isPresenceState(raw)) return raw;
    throw new BadRequestException(`state must be one of: ${PRESENCE_STATES.join(', ')}`);
  }

  /** One mapping per distinguishable answer — never one flat 403 for two different problems. */
  private finish(res: SetResponseWire) {
    this.throwOnStatus(res?.status);
    return {
      // ⭐ `unchanged` is surfaced, not swallowed. A client that asked for a change and got none
      // should be able to tell, and FR-015 makes the difference observable on purpose: one path
      // writes exactly one history record and the other must write none.
      changed: is(res?.status, 'OK'),
      presence: toJson(res?.presence),
    };
  }

  private throwOnStatus(status?: number | string): void {
    if (is(status, 'FORBIDDEN')) throw new ForbiddenException();
    if (is(status, 'NO_SUCH_OPERATOR')) throw new NotFoundException();
    if (is(status, 'UNKNOWN_LABEL')) throw new NotFoundException();
    if (is(status, 'NAME_TAKEN')) throw new UnprocessableEntityException('name already in use');
  }
}
