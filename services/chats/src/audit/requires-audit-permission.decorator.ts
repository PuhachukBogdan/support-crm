import { SetMetadata } from '@nestjs/common';

/** Metadata key: the permission an audit gRPC handler requires (feature 015, roadmap 4.8). */
export const REQUIRED_AUDIT_PERMISSION_KEY = 'rbac:audit_required_permission';

/**
 * Declare the permission an audit read handler requires. {@link AuditAccessGuard} enforces it against the
 * caller-permission context carried in gRPC metadata — independently of the gateway, so a call that skips
 * the gateway is still refused at the service tier (Principle II).
 *
 * There is deliberately no write-side counterpart: audit entries are written in-process, inside the
 * transaction of the action they describe, so there is no caller-facing write handler to gate.
 */
export const RequiresAuditPermission = (permission: string) =>
  SetMetadata(REQUIRED_AUDIT_PERMISSION_KEY, permission);
