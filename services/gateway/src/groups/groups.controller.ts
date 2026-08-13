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
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom, type Observable } from 'rxjs';
import type { Request } from 'express';
import { AUTH_CLIENT } from '../grpc/clients.module';
import type { RequestClaims } from '../auth/auth.guard';
import { EffectivePermsCache } from '../security/effective-perms.cache';
import { RequiresPermission } from '../security/requires-permission.decorator';

/**
 * Groups edge (feature 024, roadmap 5.3 — ADR 0039). A thin proxy over the auth group surface, plus
 * the one thing the edge owns: **cache invalidation**.
 *
 * ── Why invalidation is a feature and not a detail ──────────────────────────────────────────────
 * `EffectivePermsCache` holds a caller's resolved permissions for 30 seconds and relies entirely on
 * explicit invalidation for freshness (feature 011, R-1). A membership change and a grant change are
 * both privilege changes, so both must invalidate — and for a grant change that is EVERY MEMBER of
 * the group, which is why `affected_user_ids` is part of the mutation's answer rather than something
 * the edge could work out. A stale grant surviving a revocation is a live authorization defect; the
 * TTL is not a fallback anyone should be relying on.
 *
 * ── Two tiers, and neither is decorative ────────────────────────────────────────────────────────
 * `@RequiresPermission('platform.group.manage')` gates here (fast, at the edge). Auth re-checks it
 * authoritatively by resolving the caller's own effective permissions, so a call that skips the
 * gateway is refused on the same grounds — and, for a grant, additionally refuses to confer a key the
 * caller does not hold (no-escalation, FR-015).
 *
 * The gateway does no business logic (Principle VIII): it forwards, maps a status to HTTP, and
 * invalidates.
 */

const GROUP_MANAGE = 'platform.group.manage';

interface GroupWire {
  id: string;
  name: string;
  active: boolean;
  memberCount: number;
  permissionKeys: string[];
  /** ⭐ W32: who answers for this desk; '' = nobody, which is legitimate. */
  leadUserId?: string;
}
interface MutationWire {
  status: string; // GROUP_STATUS_*
  message: string;
  affectedUserIds: string[];
  groupId: string;
}
interface CallerCtx {
  callerAccountId: string;
  callerUserId: string;
  callerRoles: string[];
}
interface GroupsGrpc {
  listGroups(d: { accountId: string }): Observable<{ groups: GroupWire[] }>;
  createGroup(d: CallerCtx & { name: string }): Observable<MutationWire>;
  renameGroup(d: CallerCtx & { groupId: string; name: string }): Observable<MutationWire>;
  deleteGroup(d: CallerCtx & { groupId: string }): Observable<MutationWire>;
  addGroupMember(d: CallerCtx & { groupId: string; userId: string }): Observable<MutationWire>;
  removeGroupMember(d: CallerCtx & { groupId: string; userId: string }): Observable<MutationWire>;
  listGroupMembers(
    d: { accountId: string; groupId: string },
  ): Observable<{ userIds: string[]; routable?: boolean }>;
  setGroupRoutable(d: CallerCtx & { groupId: string; routable: boolean }): Observable<MutationWire>;
  setGroupLead(d: CallerCtx & { groupId: string; leadUserId: string }): Observable<MutationWire>;
  clearGroupLead(d: CallerCtx & { groupId: string }): Observable<MutationWire>;
  setGroupPermission(
    d: CallerCtx & { groupId: string; permissionKey: string; grant: boolean },
  ): Observable<MutationWire>;
}

@Controller('groups')
export class GroupsController implements OnModuleInit {
  private auth!: GroupsGrpc;

  constructor(
    @Inject(AUTH_CLIENT) private readonly client: ClientGrpc,
    @Inject(EffectivePermsCache) private readonly cache: EffectivePermsCache,
  ) {}

  onModuleInit(): void {
    this.auth = this.client.getService<GroupsGrpc>('AuthService');
  }

  @Get()
  @RequiresPermission(GROUP_MANAGE)
  async list(@Req() req: Request & { claims?: RequestClaims }) {
    const claims = this.caller(req);
    return firstValueFrom(this.auth.listGroups({ accountId: claims.accountId }));
  }

  @Post()
  @RequiresPermission(GROUP_MANAGE)
  async create(
    @Body() body: { name?: string },
    @Req() req: Request & { claims?: RequestClaims },
  ) {
    const claims = this.caller(req);
    const r = await firstValueFrom(
      this.auth.createGroup({ ...this.ctx(claims), name: (body?.name ?? '').trim() }),
    );
    return this.finish(claims.accountId, r);
  }

  @Patch(':id')
  @RequiresPermission(GROUP_MANAGE)
  async rename(
    @Param('id') id: string,
    @Body() body: { name?: string },
    @Req() req: Request & { claims?: RequestClaims },
  ) {
    const claims = this.caller(req);
    const r = await firstValueFrom(
      this.auth.renameGroup({
        ...this.ctx(claims),
        groupId: id,
        name: (body?.name ?? '').trim(),
      }),
    );
    return this.finish(claims.accountId, r);
  }

  @Delete(':id')
  @RequiresPermission(GROUP_MANAGE)
  async remove(@Param('id') id: string, @Req() req: Request & { claims?: RequestClaims }) {
    const claims = this.caller(req);
    const r = await firstValueFrom(this.auth.deleteGroup({ ...this.ctx(claims), groupId: id }));
    return this.finish(claims.accountId, r);
  }

  @Get(':id/members')
  @RequiresPermission(GROUP_MANAGE)
  async members(@Param('id') id: string, @Req() req: Request & { claims?: RequestClaims }) {
    const claims = this.caller(req);
    return firstValueFrom(
      this.auth.listGroupMembers({ accountId: claims.accountId, groupId: id }),
    );
  }

  /**
   * `PUT` rather than `POST`: the membership's composite primary key already makes this idempotent,
   * and the verb should say so.
   */
  @Put(':id/members/:userId')
  @RequiresPermission(GROUP_MANAGE)
  async addMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Req() req: Request & { claims?: RequestClaims },
  ) {
    const claims = this.caller(req);
    const r = await firstValueFrom(
      this.auth.addGroupMember({ ...this.ctx(claims), groupId: id, userId }),
    );
    return this.finish(claims.accountId, r);
  }

  @Delete(':id/members/:userId')
  @RequiresPermission(GROUP_MANAGE)
  async removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @Req() req: Request & { claims?: RequestClaims },
  ) {
    const claims = this.caller(req);
    const r = await firstValueFrom(
      this.auth.removeGroupMember({ ...this.ctx(claims), groupId: id, userId }),
    );
    return this.finish(claims.accountId, r);
  }

  /**
   * ⭐ Feature 031 (roadmap 4.20): whether this desk is a **routed queue desk** — whether the router pushes
   * work to it.
   *
   * ── Why the flag needs an HTTP surface at all, before its screen exists ─────────────────────────
   * The rpc was added with the routing engine and had no route. The admin screen is a later roadmap point,
   * so the only way to flip the flag was a direct database write — which would bypass the audit entry the
   * decision is *supposed* to leave (`group.routability_changed`, written even on a no-op). An audited act
   * that no human can perform through the product is an audit trail that records nothing, and the receipt
   * cannot be produced live. Two lines here make the capability reachable by a permitted person.
   *
   * `PUT`/`DELETE` rather than a body flag, matching the permission grant below: the state is binary and
   * the verb should say which one is being asked for.
   */
  @Put(':id/routable')
  @RequiresPermission(GROUP_MANAGE)
  async markRoutable(@Param('id') id: string, @Req() req: Request & { claims?: RequestClaims }) {
    return this.setRoutable(req, id, true);
  }

  @Delete(':id/routable')
  @RequiresPermission(GROUP_MANAGE)
  async unmarkRoutable(@Param('id') id: string, @Req() req: Request & { claims?: RequestClaims }) {
    return this.setRoutable(req, id, false);
  }

  private async setRoutable(
    req: Request & { claims?: RequestClaims },
    groupId: string,
    routable: boolean,
  ) {
    const claims = this.caller(req);
    const r = await firstValueFrom(
      this.auth.setGroupRoutable({ ...this.ctx(claims), groupId, routable }),
    );
    return this.finish(claims.accountId, r);
  }

  /**
   * ⭐ W32 (roadmap 3.16, ADR 0043 §4) — who answers for this desk.
   *
   * Same key as every other desk change, and weightier than it looks: this value decides where a
   * departing colleague's own customers land. Clearing has its own verb rather than an empty id — a
   * blank arriving by accident must not silently unname the person a desk depends on.
   */
  @Put(':id/lead')
  @RequiresPermission(GROUP_MANAGE)
  async setLead(
    @Param('id') id: string,
    @Body() body: { userId?: string },
    @Req() req: Request & { claims?: RequestClaims },
  ) {
    const claims = this.caller(req);
    const r = await firstValueFrom(
      this.auth.setGroupLead({
        ...this.ctx(claims),
        groupId: id,
        leadUserId: (body?.userId ?? '').trim(),
      }),
    );
    return this.finish(claims.accountId, r);
  }

  /** A desk with NO lead is a legitimate state — the offboarding sweep has a named outcome for it. */
  @Delete(':id/lead')
  @RequiresPermission(GROUP_MANAGE)
  async clearLead(@Param('id') id: string, @Req() req: Request & { claims?: RequestClaims }) {
    const claims = this.caller(req);
    const r = await firstValueFrom(this.auth.clearGroupLead({ ...this.ctx(claims), groupId: id }));
    return this.finish(claims.accountId, r);
  }

  @Put(':id/permissions/:key')
  @RequiresPermission(GROUP_MANAGE)
  async grant(
    @Param('id') id: string,
    @Param('key') key: string,
    @Req() req: Request & { claims?: RequestClaims },
  ) {
    return this.setPermission(req, id, key, true);
  }

  @Delete(':id/permissions/:key')
  @RequiresPermission(GROUP_MANAGE)
  async revoke(
    @Param('id') id: string,
    @Param('key') key: string,
    @Req() req: Request & { claims?: RequestClaims },
  ) {
    return this.setPermission(req, id, key, false);
  }

  private async setPermission(
    req: Request & { claims?: RequestClaims },
    groupId: string,
    permissionKey: string,
    grant: boolean,
  ) {
    const claims = this.caller(req);
    const r = await firstValueFrom(
      this.auth.setGroupPermission({ ...this.ctx(claims), groupId, permissionKey, grant }),
    );
    return this.finish(claims.accountId, r);
  }

  /** Caller identity comes from the VALIDATED claims, never from the body (Principle II). */
  private caller(req: Request & { claims?: RequestClaims }): RequestClaims {
    const claims = req.claims;
    if (!claims) throw new ForbiddenException(); // fail closed.
    return claims;
  }

  private ctx(claims: RequestClaims): CallerCtx {
    return {
      callerAccountId: claims.accountId,
      callerUserId: claims.userId,
      callerRoles: claims.roles ?? [],
    };
  }

  /**
   * Map the group status → HTTP, and on success invalidate every affected user's cached permissions.
   *
   * ⚠️ The invalidation is awaited before replying. A caller that gets `200` and then immediately
   * re-reads must not be served the pre-change answer — which is precisely what a fire-and-forget
   * invalidation would allow, on the one path where being late means being wrong about access.
   */
  private async finish(accountId: string, r: MutationWire) {
    switch (r.status) {
      case 'GROUP_STATUS_OK':
        await Promise.all(
          (r.affectedUserIds ?? []).map((uid) => this.cache.invalidate(accountId, uid)),
        );
        return {
          status: 'ok',
          groupId: r.groupId ?? '',
          affectedUserIds: r.affectedUserIds ?? [],
        };
      case 'GROUP_STATUS_NAME_TAKEN':
        throw new ConflictException('a group with that name already exists');
      case 'GROUP_STATUS_INVALID_NAME':
        throw new BadRequestException('name must be non-empty and at most 256 characters');
      case 'GROUP_STATUS_UNKNOWN_PERMISSION':
        // Names the class of problem, never echoes the caller's key back — an error message must not
        // become the place unvalidated input is reflected (the feature-021 lesson).
        throw new BadRequestException('unknown permission key');
      case 'GROUP_STATUS_ESCALATION':
        // Distinct from a plain 403: they MAY manage groups; they may not give away what they do not
        // themselves hold. Conflating the two sends an administrator hunting the wrong permission.
        throw new ForbiddenException('cannot grant a permission you do not hold');
      case 'GROUP_STATUS_NOT_FOUND':
        throw new NotFoundException();
      default:
        throw new ForbiddenException();
    }
  }
}
