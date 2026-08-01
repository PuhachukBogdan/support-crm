import { ROLE_DEFAULTS, ROLE_KEYS, SYSTEM_CATALOGUE } from './catalogue';

/**
 * T014 (feature 025, roadmap 5.9) — the presence-management key is OFF for everyone until granted.
 *
 * ── The rule this protects (011 R-2 corollary) ──────────────────────────────────────────────────
 * Adding a permission to the catalogue and NOT listing it in a role's defaults means it is off for
 * that role. That rule is only worth anything if somebody checks it on the way in: a new key quietly
 * added to an agent template is indistinguishable, at review time, from a new key added to none.
 *
 * ── Why the key exists at all ───────────────────────────────────────────────────────────────────
 * Setting one's OWN presence needs no permission — a statement about oneself is not a sensitive act.
 * Setting SOMEBODY ELSE's overrides their statement about themselves and redirects the work they
 * receive, so it is gated, audited, and grantable on its own: a shift lead can be trusted to clear a
 * stuck presence without being handed anything else.
 */
const KEY = 'users.presence.manage';

describe('users.presence.manage — a scope of its own, off by default', () => {
  it('is in the catalogue, under the people-facing category', () => {
    const entry = SYSTEM_CATALOGUE.find((e) => e.key === KEY);
    expect(entry).toBeDefined();
    // `users` and not `platform`: an act on a PERSON, alongside users.list.view / portfolio.view /
    // am_notes.edit. `platform.*` is configuration.
    expect(entry?.category).toBe('users');
  });

  it('⭐ appears in NO operational role template', () => {
    const operational = ROLE_KEYS.filter((r) => r !== 'admin' && r !== 'super_admin');
    // Anti-vacuous: if the role list were ever empty this assertion would pass trivially.
    expect(operational.length).toBeGreaterThanOrEqual(5);
    for (const role of operational) {
      expect(ROLE_DEFAULTS[role]).not.toContain(KEY);
    }
  });

  it('the two administrator roles hold it, through the computed ALL_KEYS', () => {
    expect(ROLE_DEFAULTS.admin).toContain(KEY);
    expect(ROLE_DEFAULTS.super_admin).toContain(KEY);
  });

  it('is NOT a super-admin exclusive — a shift lead can be granted it', () => {
    // The contrast that gives the key its point. `platform.role.manage` is withheld from `admin` on
    // purpose; this is not, because reorganising who is on shift is routine operational work and
    // making it super-admin-only would mean nobody uses it.
    expect(ROLE_DEFAULTS.admin).not.toContain('platform.role.manage');
    expect(ROLE_DEFAULTS.admin).toContain(KEY);
  });

  it('does not exist twice under a second name', () => {
    // The 021/024 collision shape, checked cheaply: a near-duplicate key is what makes the next
    // person grant the wrong one and conclude the feature is broken.
    const presenceKeys = SYSTEM_CATALOGUE.filter((e) => e.key.includes('presence')).map((e) => e.key);
    expect(presenceKeys).toEqual([KEY]);
  });

  it('reading a colleague’s presence is NOT gated by a second new key', () => {
    // Reuse of `users.list.view` is a decision (research R10), so it is asserted: the absence of a
    // `users.presence.view` is what keeps the read grantable in practice.
    expect(SYSTEM_CATALOGUE.map((e) => e.key)).toContain('users.list.view');
    expect(SYSTEM_CATALOGUE.map((e) => e.key)).not.toContain('users.presence.view');
  });
});
