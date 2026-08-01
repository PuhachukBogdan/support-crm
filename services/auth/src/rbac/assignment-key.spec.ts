import { ROLE_DEFAULTS, ROLE_KEYS, SYSTEM_CATALOGUE } from './catalogue';

/**
 * T003 (feature 026, roadmap 5.7) — `users.player.assign` is off for everyone until granted.
 *
 * ── Why this key exists at all ──────────────────────────────────────────────────────────────────
 * Changing who looks after a player is not the same capability as seeing portfolio data. One key
 * per scope (017's precedent): a manager can be trusted to view portfolios without being trusted to
 * reorganise who owns which customer, and the reverse is also true.
 *
 * ── ⚠️ And it IS a route to the AM tier, deliberately ───────────────────────────────────────────
 * Attach yourself, read, detach. Feature 024 met the same shape in groups and closed it as a defect;
 * here it is the requested capability and the control is the audit. Asserted below so the intent is
 * on the record and a later reader does not "fix" it by mistake.
 */
const KEY = 'users.player.assign';

describe('users.player.assign — a scope of its own, off by default', () => {
  it('is in the catalogue, under the people-facing category', () => {
    const entry = SYSTEM_CATALOGUE.find((e) => e.key === KEY);
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('users');
  });

  it('⭐ appears in NO operational role template', () => {
    const operational = ROLE_KEYS.filter((r) => r !== 'admin' && r !== 'super_admin');
    // Anti-vacuous: an empty role list would make this pass trivially.
    expect(operational.length).toBeGreaterThanOrEqual(5);
    for (const role of operational) {
      expect(ROLE_DEFAULTS[role]).not.toContain(KEY);
    }
  });

  it('⚠️ not even the AM roles hold it by default, and that is the point', () => {
    // An AM can view portfolios (`users.portfolio.view`) without being able to change who owns which
    // customer. Granting it is a decision somebody makes, per person.
    expect(ROLE_DEFAULTS.am).toContain('users.portfolio.view');
    expect(ROLE_DEFAULTS.am).not.toContain(KEY);
    expect(ROLE_DEFAULTS.shift_am).not.toContain(KEY);
  });

  it('the two administrator roles hold it, through the computed ALL_KEYS', () => {
    expect(ROLE_DEFAULTS.admin).toContain(KEY);
    expect(ROLE_DEFAULTS.super_admin).toContain(KEY);
  });

  it('does NOT reuse the portfolio-viewing key, and both still exist separately', () => {
    const keys = SYSTEM_CATALOGUE.map((e) => e.key);
    expect(keys).toContain('users.portfolio.view');
    expect(keys).toContain(KEY);
  });

  it('exists exactly once, under no near-duplicate name', () => {
    // The 021/024 collision shape, checked cheaply: a near-duplicate key is what makes the next
    // person grant the wrong one and conclude the feature is broken.
    const assignKeys = SYSTEM_CATALOGUE.filter((e) => /assign/.test(e.key)).map((e) => e.key);
    expect(assignKeys.filter((k) => k.startsWith('users.'))).toEqual([KEY]);
  });
});
