import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODULE_CATALOGUE } from './nav-items';

/**
 * ⭐⭐ **Every permission the navigation names must exist in the RBAC catalogue.**
 *
 * ── The defect ──────────────────────────────────────────────────────────────────────────────────
 * Three of the four keys in `MODULE_CATALOGUE` were invented: `crm.players.read`,
 * `crm.analytics.view`, `crm.settings.manage`. The real ones are `users.list.view`,
 * `analytics.dashboard.view`, `platform.settings.manage`. A key nobody can hold hides its module
 * from **everybody, forever** — the account owner, a super-admin, saw a two-item rail with no
 * Settings and no Contacts, and it read as a product that has none.
 *
 * ── Why nothing caught it ───────────────────────────────────────────────────────────────────────
 * `module-states.test.tsx` grants permissions by writing the *same invented strings*, so the rail
 * resolved perfectly against a vocabulary that does not exist. A fixture that shares the code's
 * assumption cannot test the assumption. Only the live rail could show it, and only to someone who
 * knew Settings was supposed to be there.
 *
 * ⇒ The cross-check is against the **service that owns the catalogue**, read as text rather than
 * imported: `web` must not take a build dependency on `services/auth`, and the text is the same
 * source of truth either way.
 */
const CATALOGUE = join(
  __dirname, '..', '..', '..', '..',
  'services', 'auth', 'src', 'rbac', 'catalogue.ts',
);

function catalogueKeys(): string[] {
  const src = readFileSync(CATALOGUE, 'utf8');
  return [...src.matchAll(/key:\s*'([^']+)'/g)].map((m) => m[1]!);
}

describe('the catalogue is readable (nothing below can pass vacuously)', () => {
  it('the RBAC catalogue file exists and holds a plausible number of keys', () => {
    const keys = catalogueKeys();
    expect(keys.length).toBeGreaterThan(15);
    // A key we know is real, so a regex that silently matched nothing would fail here.
    expect(keys).toContain('crm.inbox.view');
  });

  it('the module catalogue actually declares permissions to check', () => {
    const declared = MODULE_CATALOGUE.filter((m) => m.permission);
    expect(declared.length).toBeGreaterThan(2);
  });
});

describe('*** every module permission is a REAL permission ***', () => {
  it('⭐ no module names a key the RBAC catalogue does not define', () => {
    const known = new Set(catalogueKeys());
    const invented = MODULE_CATALOGUE.filter((m) => m.permission && !known.has(m.permission)).map(
      (m) => `${m.key} → ${m.permission}`,
    );
    expect(invented).toEqual([]);
  });

  it('the detector would catch an invented key', () => {
    // The guard is only worth having if it fires; these are the three that actually shipped.
    const known = new Set(catalogueKeys());
    for (const invented of ['crm.players.read', 'crm.analytics.view', 'crm.settings.manage']) {
      expect(known.has(invented)).toBe(false);
    }
  });

  it('⚠️ the Inbox module is gated on the key the gateway itself enforces', () => {
    // If these two ever diverge, the rail hides the screen the server would happily serve, or shows
    // one it refuses — and both look like a permissions bug somewhere else entirely.
    const inbox = MODULE_CATALOGUE.find((m) => m.key === 'inbox');
    expect(inbox?.permission).toBe('crm.inbox.view');
  });
});
