/**
 * Shared RBAC permission-check core (feature 011, T008). Pure, stateless, no I/O — consumed by
 * BOTH the gateway guard AND the owning-service guards so authorization is decided identically at
 * both tiers (Constitution Principle II). The effective set is produced by the Auth resolver
 * (source of truth) and passed in; this module only decides membership.
 */

/** A caller's resolved effective permissions (mirrors the Auth `ResolveResponse`). */
export interface EffectivePermissions {
  roleKey: string;
  permissionKeys: string[];
  mode: 'inherited' | 'standalone';
  isPreview: boolean;
  readOnly: boolean;
}

/** True iff `required` is present in the caller's effective permission keys. Deny-by-default. */
export function hasPermission(effective: readonly string[], required: string): boolean {
  return effective.includes(required);
}
