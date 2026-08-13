import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Inject,
  OnModuleInit,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { type ClientGrpc } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import { firstValueFrom, type Observable } from 'rxjs';
import type { Request } from 'express';
import type { EffectivePermissions } from '@crm/common';
import type { RequestClaims } from '../auth/auth.guard';
import { RequiresPermission } from '../security/requires-permission.decorator';
import { buildActorMetadata } from '../chats/actor-metadata';
import { AUTH_CLIENT } from '../grpc/clients.module';
import { DeniedAddressCache } from './denied-address.cache';

/**
 * ⭐ W32 (roadmap 12.10) — the screen where an administrator manages banned addresses.
 *
 * Two tiers, as always: the key is checked here and again in auth from the forwarded context. The
 * refusal at the boundary is a different mechanism entirely (`deny.middleware.ts`) and needs no
 * permission — it runs before anybody has one.
 *
 * ⚠️ Every write invalidates this gateway's cached copy, so a ban an administrator saves is in force
 * for them immediately rather than up to a refresh interval later. Other instances follow within the
 * cache's own window; that window is stated on the screen rather than left to be discovered.
 */

interface DeniedAddressWire {
  id?: string;
  address?: string;
  note?: string;
  createdBy?: string;
  createdAt?: string;
}

interface AuthDenyGrpc {
  listDeniedAddresses(d: Record<string, unknown>, md: unknown): Observable<{ addresses?: DeniedAddressWire[] }>;
  addDeniedAddress(
    d: Record<string, unknown>,
    md: unknown,
  ): Observable<{ address?: DeniedAddressWire; created?: boolean }>;
  removeDeniedAddress(d: Record<string, unknown>, md: unknown): Observable<{ removed?: boolean }>;
}

type AdminReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

const PERMISSION = 'platform.settings.manage';

@Controller('admin/denied-addresses')
export class DeniedAddressesController implements OnModuleInit {
  private auth!: AuthDenyGrpc;

  constructor(
    @Inject(AUTH_CLIENT) private readonly client: ClientGrpc,
    @Inject(DeniedAddressCache) private readonly cache: DeniedAddressCache,
  ) {}

  onModuleInit(): void {
    this.auth = this.client.getService<AuthDenyGrpc>('AuthService');
  }

  private meta(req: AdminReq) {
    return buildActorMetadata(req.claims as RequestClaims, req.effective);
  }

  @Get()
  @RequiresPermission(PERMISSION)
  async list(@Req() req: AdminReq) {
    const res = await firstValueFrom(
      this.auth.listDeniedAddresses(
        { callerAccountId: req.claims?.accountId, callerUserId: req.claims?.userId },
        this.meta(req),
      ),
    );
    // Named, never a bare array — a collection that grows a sibling field later would otherwise be a
    // breaking change for every reader.
    return { addresses: res.addresses ?? [] };
  }

  @Post()
  @RequiresPermission(PERMISSION)
  async add(@Req() req: AdminReq) {
    const body = (req.body ?? {}) as { address?: unknown; note?: unknown };
    try {
      const res = await firstValueFrom(
        this.auth.addDeniedAddress(
          {
            callerAccountId: req.claims?.accountId,
            callerUserId: req.claims?.userId,
            address: String(body.address ?? '').trim(),
            note: String(body.note ?? '').trim(),
          },
          this.meta(req),
        ),
      );
      // The ban must bite now, for the administrator who just saved it. Without this they could add
      // their own address, see it listed, and keep browsing for half a minute — which reads as a
      // control that does not work.
      await this.cache.invalidate();
      // `created: false` = it was already listed. Not an error: the same intent, expressed twice.
      return { address: res.address ?? null, created: res.created === true };
    } catch (e) {
      if ((e as { code?: number })?.code === GrpcStatus.INVALID_ARGUMENT) {
        throw new BadRequestException({ error: 'invalid_address' });
      }
      throw e as Error;
    }
  }

  @Delete(':id')
  @RequiresPermission(PERMISSION)
  async remove(@Param('id') id: string, @Req() req: AdminReq) {
    const res = await firstValueFrom(
      this.auth.removeDeniedAddress(
        { callerAccountId: req.claims?.accountId, callerUserId: req.claims?.userId, id },
        this.meta(req),
      ),
    );
    await this.cache.invalidate();
    // `removed: false` = it was already gone. A second click is not a 404.
    return { removed: res.removed === true };
  }
}
