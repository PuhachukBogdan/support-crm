import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import { status as GrpcStatus } from '@grpc/grpc-js';
import type { Metadata, MetadataValue } from '@grpc/grpc-js';
import { hasPermission } from '@crm/common';
import { REQUIRED_AUDIT_PERMISSION_KEY } from './requires-audit-permission.decorator';

/**
 * Service-tier RBAC guard for audit reads (feature 015). The SECOND, independent tier (Principle II): the
 * gateway checks `platform.audit.view` too, and a call that skips the gateway carries no valid permission
 * context and is refused here.
 *
 * The same shape as the users service's player guard (feature 011) — deliberately duplicated rather than
 * shared, because `libs/common` carries no NestJS dependency and adding one to host a guard would be a
 * larger change than a 30-line copy.
 *
 * Explicit @Inject: the service runtime (tsx/esbuild) emits no decorator metadata.
 */
@Injectable()
export class AuditAccessGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'rpc') return true;

    const required = this.reflector.getAllAndOverride<string | undefined>(
      REQUIRED_AUDIT_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true; // handler not permission-gated.

    const md = context.switchToRpc().getContext<Metadata>();
    const perms = readPermissions(md);
    if (perms.length === 0 || !hasPermission(perms, required)) {
      // Generic — reveals nothing about why (no enumeration).
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
