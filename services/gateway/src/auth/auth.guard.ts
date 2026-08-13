import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { GATEWAY_CONFIG, type GatewayConfig } from '../config';
import { IS_PUBLIC_KEY } from './public.decorator';
import { ACCESS_COOKIE } from './session-cookie';
import { verifyAccessToken } from './verify-access-token';

/** Claims attached to the request after a successful guard pass (consumed by 011 for RBAC). */
export interface RequestClaims {
  userId: string;
  accountId: string;
  roles: string[];
}

/**
 * Global authentication guard (feature 009, T020). Every HTTP route except `@Public()` ones
 * requires a valid session: the guard reads the httpOnly `access` cookie and verifies the JWT
 * **locally** (signature + expiry, shared `JWT_SECRET`) — no per-request gRPC/DB hop
 * (Principle VII). Missing/invalid/expired → 401 (fail closed, Principle II). Non-HTTP contexts
 * (WebSocket) are out of scope here and pass through.
 *
 * ⚠️ **"Pass through" means UNGUARDED here, and that sentence used to be the whole story.** Until feature
 * 034 the socket surface had no authorization at all, because of this very line. The realtime edge now
 * authorizes at its own handshake — `ws/realtime.gateway.ts`, using the same {@link verifyAccessToken} this
 * guard uses — so a reader who stops at this comment does not conclude the socket is open. If a second
 * WebSocket gateway is ever added, it inherits nothing from here and must do the same.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    // Explicit @Inject — the service runtime (tsx/esbuild) emits no decorator metadata,
    // so class-typed params (incl. framework providers) must name their token.
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(GATEWAY_CONFIG) private readonly cfg: GatewayConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request & { claims?: RequestClaims }>();
    const token = (req.cookies as Record<string, string> | undefined)?.[ACCESS_COOKIE];
    /**
     * ⚠️ The verification itself lives in `verifyAccessToken` and is **shared with the WebSocket edge**
     * (feature 034). It used to be inline here, which was correct while this was the only caller — and
     * the moment the socket needed the same check, a copy of it would have been the defect: two verifiers
     * drift, and the weaker one is the one that gets used.
     */
    const claims = verifyAccessToken(this.jwt, this.cfg.JWT_SECRET, token);
    if (!claims) throw new UnauthorizedException();
    req.claims = claims;
    return true;
  }
}
