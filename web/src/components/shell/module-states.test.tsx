import {
  MODULE_CATALOGUE,
  parseModuleOverrides,
  resolveModules,
  type NavModule,
} from './nav-items';

/**
 * T038 (feature 029 — roadmap 9.1's missing criteria, FR-020/FR-021).
 *
 * Two properties the shell had never had a definition of, let alone a test:
 *   • the rail is ASSEMBLED from the caller's permissions, not filtered from a fixed list;
 *   • a module is hidden · coming_soon · active, switchable by CONFIGURATION (R13's reserved slot).
 *
 * ⛔ These assert what is RENDERED. "A hidden module has no route and no API answer" is server-side
 * and belongs to roadmap 9.14 — asserting it here would be asserting the client's opinion of it.
 */
/**
 * ⚠️ **REAL keys, from the RBAC catalogue.** This list previously held invented ones
 * (`crm.players.read`, `crm.analytics.view`, `crm.settings.manage`), which is exactly why nothing
 * caught the defect: the fixture granted the same strings the code required, so the rail resolved
 * perfectly against a vocabulary that does not exist and the owner's Settings entry never appeared.
 * `nav-permissions.test.ts` now pins these against the catalogue itself.
 */
const ALL = [
  'crm.inbox.view',
  'users.list.view',
  'analytics.dashboard.view',
  'platform.settings.manage',
];

describe('the catalogue is well formed (nothing below can pass vacuously)', () => {
  it('is non-empty, keys are unique, and every state is one of the three', () => {
    expect(MODULE_CATALOGUE.length).toBeGreaterThan(3);
    const keys = MODULE_CATALOGUE.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const m of MODULE_CATALOGUE) {
      expect(['hidden', 'coming_soon', 'active']).toContain(m.state);
    }
  });

  it('contains at least one module of each state — otherwise the tests below prove nothing', () => {
    const states = new Set(MODULE_CATALOGUE.map((m) => m.state));
    expect(states).toEqual(new Set(['hidden', 'coming_soon', 'active']));
  });

  it('⭐ R13: the telephony slot is RESERVED, not deleted', () => {
    // «убрать, но нужно её оставить, чтобы её можно было вернуть». Deleting the entry is the thing
    // the operator explicitly asked us not to do — bringing it back would be a code change.
    const telephony = MODULE_CATALOGUE.find((m) => m.key === 'telephony');
    expect(telephony).toBeDefined();
    expect(telephony!.state).toBe('hidden');
  });

  it('⛔ there is no "Dashboard" module — `/` is the Inbox now (FR-001)', () => {
    expect(MODULE_CATALOGUE.find((m) => m.key === 'dashboard')).toBeUndefined();
    expect(MODULE_CATALOGUE.find((m) => m.href === '/')!.key).toBe('inbox');
  });

  it('⭐ Admin Center is a RESERVED slot on the rail (roadmap 9.8, ADR 0034)', () => {
    const admin = MODULE_CATALOGUE.find((m) => m.key === 'admin');
    expect(admin).toBeDefined();
    expect(admin!.label).toBe('Admin Center');
    expect(admin!.href).toBe('/admin');
    // Marked, not built: the rail says "soon" and the route serves the reserved screen.
    expect(admin!.state).toBe('coming_soon');
  });

  it('⚠️ Admin Center carries its permission ALREADY, before it is switched on', () => {
    // `coming_soon` is shown regardless of permission, so this key does nothing today — which is
    // exactly why it is easy to omit. Omitting it would make an admin surface visible to everybody
    // on the day it flips to `active`. The key itself is cross-checked against the RBAC catalogue by
    // `nav-permissions.test.ts`; here we only pin that ONE is declared.
    const admin = MODULE_CATALOGUE.find((m) => m.key === 'admin')!;
    expect(admin.permission).toBe('platform.role.manage');
  });

  it('⭐ Admin Center sits directly ABOVE Analytics — the position was the instruction', () => {
    // Asserted as adjacency rather than an index: inserting an unrelated module elsewhere in the rail
    // must not fail this test, but moving Analytics above Admin Center must.
    const keys = MODULE_CATALOGUE.map((m) => m.key);
    expect(keys.indexOf('admin')).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf('analytics')).toBe(keys.indexOf('admin') + 1);
  });
});

describe('*** the rail is assembled from permissions (FR-020) ***', () => {
  it('a person with every permission sees every non-hidden module', () => {
    const keys = resolveModules(ALL).map((m) => m.key);
    expect(keys).not.toContain('telephony'); // hidden by configuration
    expect(keys).toContain('inbox');
    expect(keys).toContain('settings');
  });

  it('⭐ a line agent gets the minimal rail — tickets, the placeholders, and THEIR OWN settings (R26)', () => {
    // ⚠️ AMENDED by W18, and the amendment corrects a misreading this test itself shipped. It used
    // to assert "no settings" in R26's name — but R26's actual words put «their own settings» on
    // the minimal rail, and the entry it was hiding is the PERSONAL shell (ADR 0035), not tenant
    // configuration (that is the Admin Center, which stays gated). The old assertion made a
    // person's own theme unreachable for every agent.
    const keys = resolveModules(['crm.inbox.view']).map((m) => m.key);
    expect(keys).toContain('inbox');
    expect(keys).toContain('settings');
    expect(keys).not.toContain('contacts');
    expect(keys).not.toContain('admin');
    expect(keys).not.toContain('vip');
  });

  it('⚠️ NO permissions means almost nothing — deny-by-default, never "unknown so show all"', () => {
    const keys = resolveModules([]).map((m) => m.key);
    expect(keys).not.toContain('inbox');
    // Only the permissionless entries survive: placeholders that grant nothing, and the personal
    // settings shell — which grants nothing either (it is the caller's own theme and profile).
    for (const key of keys) {
      const m = MODULE_CATALOGUE.find((c) => c.key === key)!;
      expect(m.permission).toBeUndefined();
    }
  });

  it('a module added to the catalogue is INVISIBLE until someone is granted it', () => {
    // The difference between assembling from the permitted set and filtering a fixed list. Filtering
    // would make a new module visible to everyone until somebody remembered to hide it.
    const withNew: NavModule[] = [
      ...MODULE_CATALOGUE,
      { key: 'billing', label: 'Billing', href: '/billing', icon: MODULE_CATALOGUE[0]!.icon, permission: 'crm.billing.view', state: 'active' },
    ];
    expect(resolveModules(ALL, {}, withNew).map((m) => m.key)).not.toContain('billing');
    expect(resolveModules([...ALL, 'crm.billing.view'], {}, withNew).map((m) => m.key)).toContain(
      'billing',
    );
  });
});

describe('*** the three states are configuration, not a code change (FR-021) ***', () => {
  it('⭐ telephony comes back with one configuration value, and no edit to this file', () => {
    const keys = resolveModules(ALL, parseModuleOverrides('telephony:active')).map((m) => m.key);
    expect(keys).toContain('telephony');
  });

  it('an active module can be hidden the same way', () => {
    const keys = resolveModules(ALL, parseModuleOverrides('settings:hidden')).map((m) => m.key);
    expect(keys).not.toContain('settings');
  });

  it('a coming-soon module is rendered, and is marked as such rather than looking broken', () => {
    const knowledge = resolveModules(ALL).find((m) => m.key === 'knowledge');
    expect(knowledge?.state).toBe('coming_soon');
  });

  /**
   * ⭐⭐ **REVERSED in W13, and the reversal is the interesting part.**
   *
   * This used to assert the opposite — *"a coming-soon module needs no permission"* — with a
   * comment explaining that gating placeholders would hide every reserved slot from everybody.
   * Signing in as a line agent on the stand showed them **Admin Center** and **Analytics**, which
   * is exactly what R26 forbids (*«их не грузить лишними окнами»*). The rule was reasonable and the
   * screen disagreed; the screen wins.
   */
  it('⭐ a coming-soon module that DECLARES a permission is gated by it (R26)', () => {
    // Analytics declares `analytics.dashboard.view`: an agent without it does not see the slot…
    expect(resolveModules([], parseModuleOverrides('analytics:coming_soon')).map((m) => m.key)).not.toContain(
      'analytics',
    );
    // …and a supervisor who holds it does.
    expect(
      resolveModules(['analytics.dashboard.view'], parseModuleOverrides('analytics:coming_soon')).map((m) => m.key),
    ).toContain('analytics');
  });

  it('…while a placeholder with NO permission stays visible to everyone', () => {
    // Knowledge Base, Escalations and Workforce declare none — "reserved for the whole company"
    // is what that actually means, and R19 wants the KB entry from day one.
    const keys = resolveModules([]).map((m) => m.key);
    expect(keys).toContain('knowledge');
    expect(keys).toContain('escalations');
    expect(keys).toContain('workforce');
  });

  it('⚠️ a malformed override is IGNORED — a typo must not black out a module', () => {
    for (const raw of ['telephony', 'telephony:', ':active', 'telephony:nonsense', '  ', ',,,']) {
      expect(parseModuleOverrides(raw).telephony).toBeUndefined();
    }
    // …and the catalogue default still stands, rather than the app failing to boot.
    expect(resolveModules(ALL, parseModuleOverrides('telephony:nonsense')).map((m) => m.key)).not.toContain(
      'telephony',
    );
  });

  it('parses several overrides at once, trimming whitespace', () => {
    expect(parseModuleOverrides(' telephony:active , settings:hidden ')).toEqual({
      telephony: 'active',
      settings: 'hidden',
    });
  });
});
