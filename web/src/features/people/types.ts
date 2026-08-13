/** W14 (roadmap 3.8 + 3.9) — the admin screen's wire shapes. Staff facts only; no customer data. */

export interface StaffWire {
  userId: string;
  email: string;
  /** `''` when the person has never set one — the screen shows the email rather than inventing one. */
  displayName: string;
  /** active | invited | pending | disabled — the same column the login path honours. */
  status: string;
  /** One role per person: assigning replaces. `''` for somebody with none yet. */
  roleKey: string;
  /**
   * ⭐⭐ Does this person still INHERIT their role's permissions? `false` once they have been
   * personalised: their set is a standalone snapshot from that moment, so **changing their role
   * does not change what they may do** until somebody resets them to defaults (ADR 0034).
   *
   * Found by W14's live round — the probe's role changed and their access did not, because an
   * earlier block had granted them one override. The screen says it; a role control that silently
   * does nothing is worse than one that is absent.
   */
  inheritsRole?: boolean;
}

export interface GroupWire {
  id: string;
  name: string;
  active: boolean;
  memberCount: number;
  permissionKeys?: string[];
}

/**
 * ⚠️ The seven roles live server-side as constants and there is **no route that lists them**. The
 * screen therefore states them here, and the honest consequence is written down: a role added in
 * `services/auth/src/rbac/catalogue.ts` will not appear in this control until this list is edited
 * too. The alternative — inventing a `ListRoles` rpc for a set that has not changed since Phase 3 —
 * was judged the larger cost; if the set ever moves, the rpc is the fix, not a longer array.
 *
 * ⛔ `super_admin` is deliberately absent: the server refuses to assign it through this path at all
 * (an ownership act, not an administrative one), so offering it would be a control that 403s.
 */
export const ASSIGNABLE_ROLES = [
  'support_agent',
  'vip_support',
  'am',
  'shift_am',
  'teamlead',
  'admin',
] as const;

/**
 * W14 remainder (roadmap 3.8) — which roles the invite form OFFERS. Render-only, mirroring the
 * server's `canInvite` (services/auth/src/auth/invite.service.ts, feature 010): a super-admin may
 * invite any listed role; an admin may invite any of them EXCEPT `admin`; everybody else gets no
 * form at all. The server re-checks regardless — this only avoids offering a control that 403s.
 * `super_admin` is not here for the same reason it is not assignable: it originates only from the
 * whitelist, and no invite path may create one.
 */
export function invitableRoles(callerRoles: readonly string[]): readonly string[] {
  if (callerRoles.includes('super_admin')) return ASSIGNABLE_ROLES;
  if (callerRoles.includes('admin')) return ASSIGNABLE_ROLES.filter((r) => r !== 'admin');
  return [];
}
