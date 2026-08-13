import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata } from '@grpc/grpc-js';
import { hasPermission } from '@crm/common';
import { REQUIRED_AUTH_PERMISSION_KEY } from './requires-auth-permission.decorator';
import { readActorPermissions } from './actor-context';

/**
 * Service-tier RBAC guard for auth handlers (W31 / 038 — the shape of `ChatsAccessGuard`).
 *
 * The SECOND, independent tier (Principle II): the gateway checks the same key on the route, and a
 * call that arrives without the gateway carries no permission context and is refused here. For the
 * key surface that matters more than usual — an API key mints staff accounts (SEC-PV1), so "the
 * screen hides the button" is not a control at all.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class AuthAccessGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'rpc') return true;

    const required = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_AUTH_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true; // handler not permission-gated.

    const md = context.switchToRpc().getContext<Metadata>();
    const perms = readActorPermissions(md);
    if (perms.length === 0 || !hasPermission(perms, required)) {
      // Generic — reveals nothing about why (no enumeration).
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    return true;
  }
}
