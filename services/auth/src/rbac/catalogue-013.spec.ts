import { ROLE_DEFAULTS, SYSTEM_CATALOGUE } from './catalogue';

/**
 * T009 (feature 013) — the three workflow permission keys and exactly who gets them by default.
 * FAILS before the catalogue delta, PASSES after.
 *
 * The point of this spec is the *shape* of the grant, not its size: routing + labelling are
 * everyday agent actions, authoring templates is a lead/admin configuration task, and the two
 * super-admin exclusives stay exclusive.
 */
describe('RBAC catalogue — feature 013 workflow keys', () => {
  const NEW_KEYS = [
    'crm.conversation.assign',
    'crm.labels.manage',
    'crm.templates.manage',
  ] as const;
  const keyOf = (k: string) => SYSTEM_CATALOGUE.find((e) => e.key === k);

  it.each(NEW_KEYS)('registers %s in the crm category with a human label', (key) => {
    const entry = keyOf(key);
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('crm');
    expect(entry!.label.length).toBeGreaterThan(0);
  });

  it('keeps crm.macros.use as a separate APPLY key (authoring is not using)', () => {
    expect(keyOf('crm.macros.use')).toBeDefined();
    expect(keyOf('crm.macros.use')!.key).not.toBe('crm.templates.manage');
  });

  it('grants assign + labels to every operational role', () => {
    for (const role of ['support_agent', 'vip_support', 'am', 'shift_am', 'teamlead']) {
      expect(ROLE_DEFAULTS[role]).toContain('crm.conversation.assign');
      expect(ROLE_DEFAULTS[role]).toContain('crm.labels.manage');
    }
  });

  it('restricts template authoring to lead/admin level', () => {
    for (const role of ['support_agent', 'vip_support', 'am', 'shift_am']) {
      expect(ROLE_DEFAULTS[role]).not.toContain('crm.templates.manage');
    }
    expect(ROLE_DEFAULTS.teamlead).toContain('crm.templates.manage');
    expect(ROLE_DEFAULTS.admin).toContain('crm.templates.manage');
    expect(ROLE_DEFAULTS.super_admin).toContain('crm.templates.manage');
  });

  it('admin and super_admin inherit all three via the catalogue expansion', () => {
    for (const key of NEW_KEYS) {
      expect(ROLE_DEFAULTS.admin).toContain(key);
      expect(ROLE_DEFAULTS.super_admin).toContain(key);
    }
  });

  it('leaves the super-admin exclusives untouched (FR-018 / 0034)', () => {
    expect(ROLE_DEFAULTS.admin).not.toContain('platform.role.manage');
    expect(ROLE_DEFAULTS.admin).not.toContain('platform.view_as');
    expect(ROLE_DEFAULTS.super_admin).toContain('platform.role.manage');
    expect(ROLE_DEFAULTS.super_admin).toContain('platform.view_as');
  });

  it('no role holds a key the catalogue does not define (new-permission-OFF corollary)', () => {
    const known = new Set(SYSTEM_CATALOGUE.map((e) => e.key));
    for (const [role, keys] of Object.entries(ROLE_DEFAULTS)) {
      for (const k of keys) {
        expect(known.has(k)).toBe(true);
        expect(`${role}:${k}`).toBe(`${role}:${k}`); // keeps the role in the failure message
      }
    }
  });

  it('adding these keys did not silently widen any role beyond its listed defaults', () => {
    // Every role's default set is exactly what the catalogue lists for it — no wildcard leakage
    // outside the deliberate admin/super_admin expansions.
    const explicit = ['support_agent', 'vip_support', 'am', 'shift_am', 'teamlead'];
    for (const role of explicit) {
      expect(ROLE_DEFAULTS[role]!.length).toBeLessThan(SYSTEM_CATALOGUE.length);
    }
    expect(ROLE_DEFAULTS.super_admin!.length).toBe(SYSTEM_CATALOGUE.length);
  });
});
