/** ⭐⭐ W28 (9.8, R45) — the Access-Management window's wire shapes. Staff facts only. */

export interface CataloguePermissionWire {
  key: string;
  label: string;
  introducedVersion?: number;
}

export interface CatalogueCategoryWire {
  category: string;
  permissions: CataloguePermissionWire[];
}

export interface CatalogueWire {
  categories: CatalogueCategoryWire[];
}

/**
 * One person's permission FACTS, three lists (the gateway's `users/:id/permissions` read).
 *
 * ⚠️ The grid's toggle reflects `baseKeys` — the term per-person editing controls. A key in
 * `groupKeys` renders as «via group», never as a switch: the union is live and grants-only
 * (0039), so toggling it off here would spring back and read as a broken control.
 */
export interface PersonPermissionsWire {
  roleKey: string;
  /** `standalone` = personalised snapshot; a role change stops moving their access (ADR 0034). */
  mode: 'inherited' | 'standalone';
  effectiveKeys: string[];
  baseKeys: string[];
  groupKeys: string[];
}

export interface RoleDefaultsWire {
  permissionKeys: string[];
}

/** Which entity the grid is editing — the operator's three levels, plus the ad-hoc selection. */
export type Scope =
  | { kind: 'person'; userId: string }
  | { kind: 'selection'; userIds: string[] }
  | { kind: 'role'; roleKey: string }
  | { kind: 'group'; groupId: string };
