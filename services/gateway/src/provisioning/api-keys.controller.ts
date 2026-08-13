import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
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

/**
 * ⭐ W31 (roadmap 3.17) — the admin screen's edge: list, issue, rotate, revoke an integration key.
 *
 * ── Two tiers, and the one here is the WEAKER of them ────────────────────────────────────────────
 * `@RequiresPermission` stops the request before it costs anything, and auth checks the same key
 * again from the forwarded context (Principle II). A hidden button proves nothing about a crafted
 * request, and this credential mints staff accounts — so the check that matters is the far one.
 *
 * ── ⚠️ The one-shot value passes THROUGH here and stops nowhere ──────────────────────────────────
 * Issue and rotate answer `{ key, value }`, and `value` is the only credential material this product
 * ever returns. It is not logged, not cached, not stored and not re-readable: `GET` answers keys with
 * no `value` member at all, because the absence is the protection rather than a redaction somebody
 * has to remember. This file has no logger, deliberately.
 */

interface ApiKeyWire {
  id?: string;
  consumer?: string;
  fingerprint?: string;
  ipAllowList?: string[];
  ratePerHour?: number;
  active?: boolean;
  lastUsedAt?: string;
  createdAt?: string;
  rotatedFromId?: string;
}

interface AuthApiKeysGrpc {
  listApiKeys(d: Record<string, never>, md: unknown): Observable<{ keys?: ApiKeyWire[] }>;
  issueApiKey(
    d: { consumer: string; ipAllowList: string[]; ratePerHour: number },
    md: unknown,
  ): Observable<{ key?: ApiKeyWire; value?: string }>;
  rotateApiKey(d: { keyId: string }, md: unknown): Observable<{ key?: ApiKeyWire; value?: string }>;
  revokeApiKey(d: { keyId: string }, md: unknown): Observable<{ revoked?: boolean }>;
}

type AdminReq = Request & { claims?: RequestClaims; effective?: EffectivePermissions };

const PERMISSION = 'platform.settings.manage';

/** gRPC codes → the HTTP the screen already knows how to read. */
function translate(e: unknown): never {
  const code = (e as { code?: number })?.code;
  const message = (e as { details?: string })?.details ?? 'request refused';
  if (code === GrpcStatus.NOT_FOUND) throw new NotFoundException({ error: 'not_found' });
  if (code === GrpcStatus.ALREADY_EXISTS) throw new ConflictException({ error: 'consumer_taken' });
  if (code === GrpcStatus.FAILED_PRECONDITION) throw new ConflictException({ error: 'already_revoked', message });
  if (code === GrpcStatus.INVALID_ARGUMENT) throw new BadRequestException({ error: 'invalid' });
  throw e as Error;
}

@Controller('admin/api-keys')
export class AdminApiKeysController implements OnModuleInit {
  private keys!: AuthApiKeysGrpc;

  constructor(@Inject(AUTH_CLIENT) private readonly authClient: ClientGrpc) {}

  onModuleInit(): void {
    this.keys = this.authClient.getService<AuthApiKeysGrpc>('AuthService');
  }

  private meta(req: AdminReq) {
    return buildActorMetadata(req.claims as RequestClaims, req.effective);
  }

  @Get()
  @RequiresPermission(PERMISSION)
  async list(@Req() req: AdminReq) {
    const res = await firstValueFrom(this.keys.listApiKeys({}, this.meta(req)));
    // `keys`, matching the screen's registry entry. Never a bare array: a collection that grows a
    // sibling field later would otherwise be a breaking change for every reader.
    return { keys: res.keys ?? [] };
  }

  @Post()
  @RequiresPermission(PERMISSION)
  async issue(@Req() req: AdminReq) {
    const body = (req.body ?? {}) as { consumer?: unknown; ipAllowList?: unknown; ratePerHour?: unknown };
    try {
      const res = await firstValueFrom(
        this.keys.issueApiKey(
          {
            consumer: String(body.consumer ?? '').trim(),
            // ⚠️ An empty list is a LEGAL and meaningful value — it means «nobody, ever», because the
            // allow-list is fail-closed (@crm/common). It must survive the edge unchanged rather
            // than being read as «not specified» and widened to everybody.
            ipAllowList: Array.isArray(body.ipAllowList) ? body.ipAllowList.map(String) : [],
            ratePerHour: Number(body.ratePerHour ?? 0) || 0,
          },
          this.meta(req),
        ),
      );
      return { key: res.key ?? null, value: res.value ?? '' };
    } catch (e) {
      return translate(e);
    }
  }

  @Post(':keyId/rotate')
  @RequiresPermission(PERMISSION)
  async rotate(@Param('keyId') keyId: string, @Req() req: AdminReq) {
    try {
      const res = await firstValueFrom(this.keys.rotateApiKey({ keyId }, this.meta(req)));
      return { key: res.key ?? null, value: res.value ?? '' };
    } catch (e) {
      return translate(e);
    }
  }

  @Delete(':keyId')
  @RequiresPermission(PERMISSION)
  async revoke(@Param('keyId') keyId: string, @Req() req: AdminReq) {
    try {
      const res = await firstValueFrom(this.keys.revokeApiKey({ keyId }, this.meta(req)));
      // `revoked: false` means it already was. A repeat is a no-op, not an error — the screen hides
      // the action on a revoked row anyway, and a 404 for a second click would be a lie.
      return { revoked: res.revoked === true };
    } catch (e) {
      return translate(e);
    }
  }
}
