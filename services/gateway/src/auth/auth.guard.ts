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
    if (!token) throw new UnauthorizedException();

    try {
      const p = this.jwt.verify<{
        sub: string;
        account_id: string;
        roles?: string[];
      }>(token, {
        secret: this.cfg.JWT_SECRET,
      });
      req.claims = {
        userId: p.sub,
        accountId: p.account_id,
        roles: p.roles ?? [],
      };
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
