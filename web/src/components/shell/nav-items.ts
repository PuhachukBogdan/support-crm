import {
  Inbox,
  Users,
  BarChart3,
  Settings,
  BookOpen,
  Phone,
  ShieldCheck,
  AlertTriangle,
  CalendarClock,
  type LucideIcon,
} from 'lucide-react';

/**
 * The module catalogue and its three states (feature 029 — roadmap 9.1's missing criteria, FR-020/21).
 *
 * ── Three states, because "remove it" and "delete it" are different asks (R13) ───────────────────
 * The operator on telephony: *«убрать, но нужно её оставить, чтобы её можно было вернуть»* — take it
 * off the rail, but keep the slot so it can come back. With two states that is a code change every
 * time somebody changes their mind, so a module is **hidden · coming_soon · active** and the state is
 * CONFIGURATION.
 *
 * ── Permission is the other axis, and it is not the same one ─────────────────────────────────────
 * `state` says whether the product offers a module at all; `permission` says whether THIS person may
 * use it. Conflating them would make "hidden for everyone" and "not yours" one setting, so an admin
 * turning telephony back on would turn it on for the whole company.
 *
 * ⛔ **This is rendering, not enforcement.** A hidden module must also have no route and no API
 * answer, which is server-side and completed by roadmap 9.14. Nothing here grants anything.
 *
 * ⚠️ The old `NAV_ITEMS` list this replaces began with a "Dashboard" entry pointing at `/`. There is
 * no dashboard any more — `/` is the Inbox (FR-001), and the rail says so.
 */
export type ModuleState = 'hidden' | 'coming_soon' | 'active';

export interface NavModule {
  /** Stable key — what configuration names, so a relabelled module keeps its setting. */
  readonly key: string;
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
  /**
   * The permission key a person needs. `undefined` = available to any signed-in person.
   * ⚠️ Deny-by-default: an active module whose key nobody holds is hidden, never shown.
   */
  readonly permission?: string;
  /** The default state, overridable by configuration without touching this file. */
  readonly state: ModuleState;
}

/**
 * ⚠️ Order is deliberate and follows R15/R26: **Inbox first** — *«чтобы человек сразу интуитивно
 * вверху находил Inbox»*, the named anti-pattern being *«постоянно надо скроллить»*. A line agent's
 * rail is deliberately minimal (R26): tickets, knowledge base, their own profile.
 */
export const MODULE_CATALOGUE: readonly NavModule[] = [
  {
    key: 'inbox',
    label: 'Inbox',
    href: '/',
    icon: Inbox,
    permission: 'crm.inbox.view',
    state: 'active',
  },
  {
    key: 'contacts',
    label: 'Contacts',
    href: '/contacts',
    icon: Users,
    permission: 'users.list.view',
    state: 'active',
  },
  // R19: Knowledge Hub keeps its entry from the start and is filled later.
  { key: 'knowledge', label: 'Knowledge Base', href: '/knowledge', icon: BookOpen, state: 'coming_soon' },
  /**
   * ⭐ Admin Center — the access-management surface over the RBAC backbone (roadmap 9.8, ADR 0034).
   * Reserved as `coming_soon` on the operator's instruction, and deliberately placed ABOVE Analytics.
   *
   * ⚠️ It declares `platform.role.manage` even though a `coming_soon` module is shown regardless of
   * permission. That is not decoration: the day this flips to `active`, the gate must already be the
   * right one. A placeholder that ships without its permission becomes an admin entry visible to the
   * whole company the moment somebody switches it on — the failure this catalogue is shaped to
   * prevent. `nav-permissions.test.ts` checks the key against the service that owns it.
   */
  {
    key: 'admin',
    label: 'Admin Center',
    href: '/admin',
    icon: ShieldCheck,
    permission: 'platform.role.manage',
    state: 'coming_soon',
  },
  {
    key: 'analytics',
    label: 'Analytics',
    href: '/analytics',
    icon: BarChart3,
    permission: 'analytics.dashboard.view',
    state: 'coming_soon',
  },
  /**
   * ⭐ W13 (subpoint 3.13) — the two remaining TOP-LEVEL surfaces the operator approved, each given
   * a labelled place before it exists.
   *
   * **Escalations** replaces their Notion register (`cowork/escalations.md`); **Workforce** is the
   * WFM layer he kept with *«оставляем, только UX поправить»*. Both are `coming_soon` rather than
   * absent for R13's reason: a reserved slot is a promise a person can see, and adding one later is
   * a code change every time somebody changes their mind.
   *
   * ⓘ The rest of 3.13's list — Access Management, Macros, Automations, Retention, ticket statuses —
   * are NOT top-level modules: they live inside the Admin Center (§14 of the reference puts the rail
   * at Support · Knowledge · Analytics · WFM · Admin), so their slots are sections of `/admin`.
   * Putting each on the rail would answer the operator's own complaint — too many entries to scroll
   * — with exactly the thing he complained about.
   */
  { key: 'escalations', label: 'Escalations', href: '/escalations', icon: AlertTriangle, state: 'coming_soon' },
  { key: 'workforce', label: 'Workforce', href: '/workforce', icon: CalendarClock, state: 'coming_soon' },
  /**
   * ⭐ R13's reserved slot, and the reason `coming_soon`/`hidden` are states rather than a deletion.
   * Removing this entry is precisely what the operator asked us not to do.
   */
  { key: 'telephony', label: 'Telephony', href: '/telephony', icon: Phone, state: 'hidden' },
  {
    key: 'settings',
    label: 'Settings',
    href: '/settings',
    icon: Settings,
    permission: 'platform.settings.manage',
    state: 'active',
  },
];

/**
 * ⚠️⚠️ **Every key above must exist in the RBAC catalogue, and three of them did not.**
 *
 * The first version of this file invented `crm.players.read`, `crm.analytics.view` and
 * `crm.settings.manage`. None exists — the real keys are `users.list.view`,
 * `analytics.dashboard.view` and `platform.settings.manage`. A permission nobody can hold hides its
 * module from **everybody, permanently**: the account owner, a super-admin, saw a rail with two
 * entries and no Settings, and it looked like the product simply had none.
 *
 * ⭐ It is the same failure this whole feature kept finding — a name written from memory instead of
 * read from its source — committed here by the author of the note warning about it. Only
 * `crm.inbox.view` was right, and only because it was copied off the gateway controller.
 *
 * `nav-permissions.test.ts` now cross-checks this list against `services/auth/src/rbac/catalogue.ts`,
 * so an invented key fails the build instead of silently emptying somebody's navigation.
 */

/**
 * Per-module state overrides from configuration.
 *
 * Format: `key:state,key:state` — e.g. `telephony:active,analytics:hidden`. A flat string rather than
 * JSON because it is set by whoever deploys, in a shell, where quoting JSON is how mistakes happen.
 *
 * ⚠️ An unparseable entry is IGNORED and the catalogue default stands. It is deliberately not fatal
 * and deliberately not treated as `hidden`: a typo in a deployment variable must not black out a
 * module for a whole company, and a crash-on-boot turns a cosmetic mistake into an outage.
 */
export function parseModuleOverrides(raw: string | undefined): Record<string, ModuleState> {
  const out: Record<string, ModuleState> = {};
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const [key, state] = part.split(':').map((s) => s.trim());
    if (!key || !state) continue;
    if (state === 'hidden' || state === 'coming_soon' || state === 'active') out[key] = state;
  }
  return out;
}

/**
 * What this person's rail contains.
 *
 * ⭐ Assembled FROM the permitted set — never a fixed list with entries filtered out. The difference
 * shows the day a module is added: assembling means it is invisible until someone is granted it,
 * filtering means it is visible until someone remembers to hide it.
 */
export function resolveModules(
  permissionKeys: readonly string[],
  overrides: Record<string, ModuleState> = {},
  catalogue: readonly NavModule[] = MODULE_CATALOGUE,
): NavModule[] {
  return catalogue
    .map((m) => ({ ...m, state: overrides[m.key] ?? m.state }))
    .filter((m) => m.state !== 'hidden')
    .filter((m) => {
      /**
       * ⭐⭐ **W13 REVERSED this, and the live check is why.**
       *
       * The rule used to be *"a coming-soon module is a promise, not a capability, so show it to
       * everyone"* — reasoning that nobody holds a permission for a thing that does not exist.
       * Sound in the abstract, and wrong on the screen: signing in as a line agent on the stand
       * showed them **Admin Center** and **Analytics**, reserved. That is precisely what R26
       * forbids — *«их не грузить лишними окнами»*, the support rail is deliberately poor: tickets,
       * knowledge, their own settings, their own status.
       *
       * ⇒ A placeholder that DECLARES a permission is gated by it like any other module. The slot
       * still exists for the people it is for, and an agent is not shown a future admin screen they
       * will never open. A placeholder with NO permission (Knowledge Base, Escalations, Workforce)
       * stays visible to everyone — which is what "reserved for the whole company" actually means.
       *
       * ⚠️ Found by opening the product as two different roles, not by reading this file. The rule
       * it replaces had a comment explaining why it was right.
       */
      if (!m.permission) return true;
      return permissionKeys.includes(m.permission);
    });
}
