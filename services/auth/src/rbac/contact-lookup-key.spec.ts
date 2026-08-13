import { ROLE_DEFAULTS, ROLE_KEYS, SYSTEM_CATALOGUE } from './catalogue';

/**
 * W9 / spec 035 T1 (ADR 0044 §4) — `crm.contact.lookup` is off for everyone until granted.
 *
 * This is the single capability that INVERTS anti-pitching: "enter a phone number, learn whose it
 * is". The operator's terms are firm: a DISTINCT permission, never implied by "can handle tickets",
 * granted deliberately per person (3.6 overrides). It gates lookup AND attach AND detach — 0044 §5
 * says detach requires the same permission as attach, so one key covers the whole reversible pair.
 */
const KEY = 'crm.contact.lookup';

describe('crm.contact.lookup — the anti-pitching inversion, off by default', () => {
  it('is in the catalogue, under the crm category', () => {
    const entry = SYSTEM_CATALOGUE.find((e) => e.key === KEY);
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('crm');
  });

  it('⭐ appears in NO role template — agent OR supervisor', () => {
    // Sharper than the assignment key's rule: even `teamlead` does not hold this by default.
    // The workflow argument (0044 §4: the line agent handling an unknown email genuinely needs it)
    // is answered by CONTEXT-gating and per-person grants, not by a role default.
    const operational = ROLE_KEYS.filter((r) => r !== 'admin' && r !== 'super_admin');
    expect(operational.length).toBeGreaterThanOrEqual(5);
    for (const role of operational) {
      expect(ROLE_DEFAULTS[role]).not.toContain(KEY);
    }
  });

  it('the two administrator roles hold it, through the computed ALL_KEYS', () => {
    expect(ROLE_DEFAULTS.admin).toContain(KEY);
    expect(ROLE_DEFAULTS.super_admin).toContain(KEY);
  });

  it('does NOT reuse crm.contact.view — seeing contact fields ≠ searching by them', () => {
    // Every agent role holds `crm.contact.view`; if lookup rode it, the inversion would be granted
    // to the whole floor by construction — the exact shape 0044 forbids.
    const keys = SYSTEM_CATALOGUE.map((e) => e.key);
    expect(keys).toContain('crm.contact.view');
    expect(keys).toContain(KEY);
    expect(ROLE_DEFAULTS.support_agent).toContain('crm.contact.view');
    expect(ROLE_DEFAULTS.support_agent).not.toContain(KEY);
  });

  it('exists exactly once, under no near-duplicate name', () => {
    const lookupKeys = SYSTEM_CATALOGUE.filter((e) => /lookup/.test(e.key)).map((e) => e.key);
    expect(lookupKeys).toEqual([KEY]);
  });
});
