import type { AuditAction } from './catalogue';

/**
 * Feature-011 → feature-015 action mapping (roadmap 4.8).
 *
 * `PrivilegeAudit` recorded six action values. They are copied into the unified trail through this map, and
 * the SQL migration hardcodes exactly the same six cases — this module is what makes that mapping testable
 * (the migration cannot be unit tested, the map can) and what the spec asserts totality against.
 *
 * `role_change → role.assign` is a deliberate COLLAPSE, not an oversight. The old vocabulary had both, but
 * a role change *is* an assignment of the new role, and the previous role was never recorded — so keeping
 * two names would imply a distinction the data cannot support. A reader gaining a name that means nothing
 * is worse than a reader having one fewer name.
 *
 * Pure data. No I/O.
 */

/** Every action value `PrivilegeAudit.action` could hold (feature 011's `PrivilegeAction`). */
export const LEGACY_PRIVILEGE_ACTIONS = [
  'role_assign',
  'role_change',
  'role_revoke',
  'perm_grant',
  'perm_revoke',
  'reset',
] as const;

export type LegacyPrivilegeAction = (typeof LEGACY_PRIVILEGE_ACTIONS)[number];

export const LEGACY_PRIVILEGE_ACTION: Readonly<Record<LegacyPrivilegeAction, AuditAction>> = {
  role_assign: 'role.assign',
  // Collapsed on purpose — see the module comment.
  role_change: 'role.assign',
  role_revoke: 'role.revoke',
  perm_grant: 'permission.grant',
  perm_revoke: 'permission.revoke',
  reset: 'permission.reset',
};

/**
 * Map a legacy action, or `null` when it is not one of the six.
 *
 * The migration handles an unmapped value by preserving it as `legacy.<value>` rather than dropping it or
 * renaming it to something plausible: a row nobody planned for should be visible to a reader, not silently
 * absent (an audit trail that quietly loses rows is worse than one with an odd row in it).
 */
export function mapLegacyPrivilegeAction(value: string): AuditAction | null {
  return (LEGACY_PRIVILEGE_ACTION as Record<string, AuditAction>)[value] ?? null;
}

/** True when every legacy value has a mapping — asserted by the spec and by the migration's authoring. */
export function isLegacyMappingTotal(): boolean {
  return LEGACY_PRIVILEGE_ACTIONS.every((a) => mapLegacyPrivilegeAction(a) !== null);
}
