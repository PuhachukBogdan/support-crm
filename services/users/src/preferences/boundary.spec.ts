import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { Metadata } from '@grpc/grpc-js';
import { stripComments } from '@crm/common';
import { UiPreferencesController } from './ui-preferences.grpc.controller';
import type { UiPreferencesRepository } from './ui-preferences.repository';

/**
 * The boundary (feature 021 — FR-015/FR-016/FR-018/FR-022).
 *
 * Three properties that are all ABSENCES, which is why they need tests: nothing fails when an absence
 * quietly stops holding. ADR 0035 states each of them; this file is what makes them real rather than
 * documentary.
 *
 *   1. No permission decides anything here, and no preference decides access.
 *   2. Nothing here is written to the audit trail.
 *   3. The operator's settings and the CUSTOMER's `preferences_json` cannot be confused by a search.
 *
 * ── ⚠️ COMMENTS ARE STRIPPED FIRST ───────────────────────────────────────────────────────────────
 * Every check below bans a token from the CODE, and this file's own subject matter is full of
 * comments naming those tokens: the controller says in place why it does NOT read
 * `x-actor-permissions`, and why it is NOT `preferences_json`. Those notes are the point — they stop
 * the next reader adding what was deliberately left out. A guard banning the token outright would
 * force their deletion.
 *
 * The first version of this file did exactly that and failed on its own comments, one hour after the
 * brand-scope guard failed the same way. Hence `stripComments` is shared infrastructure now.
 */

const HERE = __dirname;
const ROOT = resolve(__dirname, '..', '..', '..', '..');
const SOURCES = ['ui-preferences.grpc.controller.ts', 'ui-preferences.repository.ts', 'ui-preferences.module.ts'];

/** ⚠️ Comments removed: what is asserted is what the code DOES, not what it explains. */
const sourceOf = (f: string) => stripComments(readFileSync(join(HERE, f), 'utf8'));
const allSource = SOURCES.map(sourceOf).join('\n');

describe('*** 1. no permission lives here, and no preference decides access (FR-015/FR-016) ***', () => {
  it('the preferences path reads no permission set', () => {
    // `x-actor-permissions` is deliberately not read: there is nothing to check, and reading it would
    // be the first step toward a preference that depends on a permission.
    expect(allSource).not.toContain('x-actor-permissions');
    expect(allSource).not.toMatch(/hasPermission\s*\(/);
    expect(allSource).not.toMatch(/assert\w*Permission\s*\(/);
  });

  it('it reads no role either — nothing on this surface is masked', () => {
    expect(allSource).not.toContain('x-actor-effective-role');
    expect(allSource).not.toContain('x-actor-role');
    expect(allSource).not.toMatch(/\bmask\w*\(/);
  });

  it('no permission key is declared anywhere in this folder', () => {
    // A key created for preferences would be a key with one holder: everyone. ADR 0035 is explicit
    // that a preference is not an access decision, in either direction.
    expect(allSource).not.toMatch(/'crm\.[a-z_.]+'/);
    expect(allSource).not.toMatch(/'platform\.[a-z_.]+'/);
  });

  it('the detector can fail — a planted permission read IS caught', () => {
    // The four assertions above are `not.toContain`, which pass on an empty string. Planting the shape
    // they exist to catch is what shows they can fail.
    const planted = `const perms = readStr(md, 'x-actor-permissions');`;
    expect(planted.includes('x-actor-permissions')).toBe(true);
    expect(`if (!hasPermission(perms, 'crm.settings.manage')) throw forbidden();`).toMatch(
      /hasPermission\s*\(/,
    );
  });

  it('a caller with no permissions and a caller with all of them receive the same thing', async () => {
    // The behavioural half. The structural checks above say the code does not look at permissions;
    // this says the OUTPUT does not vary with them, which is the property that actually matters.
    const values = { theme_mode: 'dark', font_size_step: 'large' };
    const repo = { read: jest.fn(async () => values), apply: jest.fn() };
    const ctl = new UiPreferencesController(repo as unknown as UiPreferencesRepository);

    const md = (perms: string) => {
      const m = new Metadata();
      m.set('x-actor-account-id', 'acc-1');
      m.set('x-actor-user-id', 'user-1');
      m.set('x-actor-permissions', perms);
      return m;
    };

    const none = await ctl.getOperatorUiPreferences({}, md(''));
    const all = await ctl.getOperatorUiPreferences({}, md('crm.contact.read_pii,platform.view_as'));
    expect(none.values).toEqual(all.values);
  });
});

describe('*** 2. nothing here is audited, and that is a decision (FR-018) ***', () => {
  it('no audit writer is imported or called in this folder', () => {
    expect(allSource).not.toMatch(/AuditRepository|ContactViewAuditService|recordView|recordBulkRead/);
    expect(allSource).not.toMatch(/auditEntry\./);
  });

  it('the reason is stated AT THE WRITE PATH, not only in a document', () => {
    // In this product a deliberate absence otherwise reads as an oversight to the next person, who
    // then "fixes" it. Feature 015 needed a guard for exactly that on `record.open`.
    //
    // ⚠️ Reads the RAW source on purpose — this is the one assertion in the file that is ABOUT a
    // comment, so stripping comments here would make it check the opposite of what it means.
    const raw = readFileSync(join(HERE, 'ui-preferences.grpc.controller.ts'), 'utf8');
    expect(raw).toMatch(/NO AUDIT ENTRY/);
    expect(raw).toMatch(/0019|SEC-29/);
  });

  it('a write reaches the repository and nothing else', async () => {
    const calls: string[] = [];
    const repo = {
      read: jest.fn(async () => ({})),
      apply: jest.fn(async () => {
        calls.push('apply');
        return {};
      }),
    };
    const ctl = new UiPreferencesController(repo as unknown as UiPreferencesRepository);
    const m = new Metadata();
    m.set('x-actor-account-id', 'acc-1');
    m.set('x-actor-user-id', 'user-1');

    await ctl.updateOperatorUiPreferences({ values: { theme_mode: 'dark' } }, m);
    expect(calls).toEqual(['apply']);
  });
});

describe('*** 3. the operator surface and the CUSTOMER field cannot be confused (FR-022) ***', () => {
  /**
   * The roadmap-4.15 failure shape: "custom attributes" existed on `Player` while the requirement
   * meant `Conversation`, and the name being taken made everyone assume the thing was built. Here the
   * collision would be worse — one side is cosmetic and open to everyone, the other is `am_only`
   * customer data masked from most roles.
   */
  function* walk(dir: string): Generator<string> {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'generated') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) yield* walk(full);
      else if (entry.endsWith('.ts')) yield full;
    }
  }

  it('nothing in the preferences folder names the customer field', () => {
    expect(allSource).not.toContain('preferences_json');
    expect(allSource).not.toContain('portfolio_json');
    expect(allSource).not.toContain('am_notes');
  });

  it('nothing in the PLAYER folder names the operator surface', () => {
    const playerDir = join(ROOT, 'services', 'users', 'src', 'player');
    const offenders = [...walk(playerDir)]
      .filter((f) => /UiPreference/.test(stripComments(readFileSync(f, 'utf8'))))
      .map((f) => relative(ROOT, f).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });

  it('⚠️ the checks above run on STRIPPED source — proved, not assumed', () => {
    // Without this, every `not.toContain` in this file would pass on a version that strips nothing
    // AND on a version that strips everything. Both extremes must be excluded.
    const withComment = `// preferences_json is the CUSTOMER's field, not this one\nconst x = 1;`;
    expect(stripComments(withComment)).not.toContain('preferences_json');
    expect(stripComments(withComment)).toContain('const x = 1;');

    const inCode = `const f = row.preferences_json;`;
    expect(stripComments(inCode)).toContain('preferences_json');
  });

  it('the contract carries a cross-reference on BOTH sides', () => {
    // Each side naming the other is what stops the next person concluding the thing already exists.
    const proto = readFileSync(
      join(ROOT, 'libs', 'proto', 'crm', 'users', 'v1', 'users.proto'),
      'utf8',
    );
    const playerField = /string preferences_json = 8;/.exec(proto);
    expect(playerField).not.toBeNull();

    // The comment block immediately above the customer field must point at the operator service…
    const beforeField = proto.slice(0, playerField!.index);
    expect(beforeField.slice(-800)).toContain('OperatorUiPreferencesService');

    // …and the operator service block must point back at the customer field.
    const svc = proto.slice(proto.indexOf('service OperatorUiPreferencesService') - 2000);
    expect(svc).toContain('preferences_json');
  });
});
