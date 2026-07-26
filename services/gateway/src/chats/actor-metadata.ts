import { Metadata } from '@grpc/grpc-js';
import type { RequestClaims } from '../auth/auth.guard';

/**
 * Build the caller-context gRPC metadata the chats service reads (feature 012, research R1/R3).
 * Identity comes from the gateway's VALIDATED claims (never the body); the effective permission set
 * is the one the global PermissionGuard already resolved (`req.effective`). The chats service-tier
 * guard re-checks `x-actor-permissions` independently (Principle II).
 *
 * Brand scope (R3): `x-actor-brands` is set ONLY when the caller's brand set is a non-empty array.
 * When brands are absent (not yet populated — Brands service, Phase 5) the key is omitted and chats
 * applies NO brand filter — mirroring the gateway guard, which also defers brand enforcement until
 * `claims.brands` is present.
 */
export function buildActorMetadata(
  claims: RequestClaims,
  permissionKeys: string[],
  opts: { preview?: boolean } = {},
): Metadata {
  const md = new Metadata();
  md.set('x-actor-account-id', claims.accountId);
  md.set('x-actor-user-id', claims.userId);
  md.set('x-actor-role', claims.roles?.[0] ?? '');
  md.set('x-actor-permissions', (permissionKeys ?? []).join(','));
  if (Array.isArray(claims.brands) && claims.brands.length > 0) {
    md.set('x-actor-brands', claims.brands.join(','));
  }
  if (opts.preview) md.set('x-is-preview', 'true');
  return md;
}
