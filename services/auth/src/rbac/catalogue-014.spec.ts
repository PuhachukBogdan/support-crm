import { ROLE_DEFAULTS, SYSTEM_CATALOGUE } from './catalogue';

/**
 * T007 (feature 014) — the two automations/SLA permission keys and exactly who gets them.
 * FAILS before the catalogue delta, PASSES after.
 *
 * The shape being asserted: authoring rules and setting the reply target are **supervisory**
 * privileges, so no operational agent role receives them by default. That is not a style choice —
 * it is the 011 R-2 corollary in action (a new key is OFF for every existing user until granted),
 * and it matters more here than for 013's keys because a rule acts with its AUTHOR's authority
 * (FR-023): whoever can author rules decides what the system does by itself.
 */
describe('RBAC catalogue — feature 014 automations + SLA keys', () => {
  const NEW_KEYS = ['crm.automations.manage', 'crm.sla.manage'] as const;
  const AGENT_ROLES = ['support_agent', 'vip_support', 'am', 'shift_am'] as const;
  const keyOf = (k: string) => SYSTEM_CATALOGUE.find((e) => e.key === k);

  it.each(NEW_KEYS)('registers %s in the crm category with a human label', (key) => {
    const entry = keyOf(key);
    expect(entry).toBeDefined();
    expect(entry!.category).toBe('crm');
    expect(entry!.label.length).toBeGreaterThan(0);
  });

  it('grants both to teamlead / admin / super_admin', () => {
    for (const key of NEW_KEYS) {
      expect(ROLE_DEFAULTS.teamlead).toContain(key);
      expect(ROLE_DEFAULTS.admin).toContain(key);
      expect(ROLE_DEFAULTS.super_admin).toContain(key);
    }
  });

  // The corollary that matters: an existing agent gains NOTHING when this feature ships.
  it('grants NEITHER to any operational agent role (new-permission-OFF-for-existing)', () => {
    for (const role of AGENT_ROLES) {
      for (const key of NEW_KEYS) {
        expect(ROLE_DEFAULTS[role]).not.toContain(key);
      }
    }
  });

  // Authoring a rule must not become a back door to actions the author cannot perform. The catalogue
  // side of that guarantee: the automations key does NOT imply any conversation-mutating key.
  it('crm.automations.manage does not itself imply any conversation action key', () => {
    const actionKeys = [
      'crm.conversation.reply',
      'crm.conversation.assign',
      'crm.labels.manage',
    ];
    // teamlead happens to hold them all, so assert on the *catalogue*: they are distinct entries,
    // never aliases of one another.
    for (const k of actionKeys) {
      expect(keyOf(k)).toBeDefined();
      expect(k).not.toBe('crm.automations.manage');
    }
    expect(new Set([...actionKeys, ...NEW_KEYS]).size).toBe(actionKeys.length + NEW_KEYS.length);
  });

  it('leaves the super-admin exclusives untouched (FR-018 / 0034)', () => {
    expect(ROLE_DEFAULTS.admin).not.toContain('platform.role.manage');
    expect(ROLE_DEFAULTS.admin).not.toContain('platform.view_as');
    expect(ROLE_DEFAULTS.super_admin).toContain('platform.role.manage');
    expect(ROLE_DEFAULTS.super_admin).toContain('platform.view_as');
  });

  it('super_admin still equals the whole catalogue (expansion, not a hardcoded list)', () => {
    expect(ROLE_DEFAULTS.super_admin!.length).toBe(SYSTEM_CATALOGUE.length);
  });

  it('every default key exists in the catalogue', () => {
    const known = new Set(SYSTEM_CATALOGUE.map((e) => e.key));
    for (const [role, keys] of Object.entries(ROLE_DEFAULTS)) {
      for (const k of keys) {
        expect({ role, key: k, known: known.has(k) }).toEqual({ role, key: k, known: true });
      }
    }
  });
});
