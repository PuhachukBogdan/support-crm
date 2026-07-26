import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { hasPermission } from '@crm/common';
import { REQUIRED_PLAYER_PERMISSION_KEY } from './requires-player-permission.decorator';

/**
 * Service-tier RBAC guard for player reads (feature 011, T019). Enforces the required permission
 * against the caller-permission CONTEXT the gateway sets in gRPC metadata (`x-actor-permissions`,
 * comma-joined). This is the SECOND, independent tier (Principle II / SC-001): a call that skips
 * the gateway carries no valid context → PERMISSION_DENIED. Users never reads auth_db (Principle
 * VIII) — it trusts only the resolved context passed to it.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class PlayerAccessGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'rpc') return true;

    const required = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_PLAYER_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true; // handler not permission-gated.

    const md = context.switchToRpc().getContext<Metadata>();
    const perms = readPermissions(md);
    if (perms.length === 0 || !hasPermission(perms, required)) {
      // Generic — reveal nothing about why (no enumeration).
      throw new RpcException({ code: GrpcStatus.PERMISSION_DENIED, message: 'forbidden' });
    }
    return true;
  }
}

/** Parse the comma-joined `x-actor-permissions` metadata value (string or Buffer). */
function readPermissions(md: Metadata | undefined): string[] {
  const raw: MetadataValue | undefined = md?.get?.('x-actor-permissions')?.[0];
  if (typeof raw === 'string') return raw.split(',').filter(Boolean);
  if (raw && typeof (raw as Buffer).toString === 'function') {
    return (raw as Buffer).toString('utf8').split(',').filter(Boolean);
  }
  return [];
}
