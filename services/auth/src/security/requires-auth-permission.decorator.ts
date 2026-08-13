import { SetMetadata } from '@nestjs/common';

/** Metadata key: the permission an auth gRPC handler requires (W31 / 038, mirrors 011 and 012). */
export const REQUIRED_AUTH_PERMISSION_KEY = 'rbac:auth_required_permission';

/**
 * Declare the permission an auth handler requires. {@link AuthAccessGuard} enforces it against the
 * caller-permission context carried in gRPC metadata (`x-actor-permissions`) — independently of the
 * gateway, so a call that skips the gateway is still refused at the service tier (Principle II).
 *
 * ⚠️ Distinct from `RequiresAuditPermission`, which gates only the append-only audit READ. This one
 * is the general auth-tier declaration; the key surface (ADR 0043 §5) is its first user.
 */
export const RequiresAuthPermission = (permission: string) =>
  SetMetadata(REQUIRED_AUTH_PERMISSION_KEY, permission);
