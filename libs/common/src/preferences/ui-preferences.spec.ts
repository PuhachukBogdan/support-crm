import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  UI_PREFERENCES,
  UI_PREFERENCE_KEYS,
  defaultUiPreferences,
  resolveUiPreferences,
  uiPreferenceOf,
  validateUiPreferencePatch,
  type UiPreferenceEntry,
} from './ui-preferences';

/**
 * The catalogue guard (feature 021, roadmap 5.6 — FR-006/FR-007/FR-009).
 *
 * ⚠️ **Why both directions are asserted.** The audit-action catalogue (015) shipped enforcing exact
 * membership only for *promotions*, and two new `live` actions slipped past it. A guard that checks
 * "everything listed is served" without checking "everything served is listed" is half a guard, and
 * the missing half is the direction things actually get added in.
 */

const ROOT = resolve(__dirname, '..', '..', '..', '..');

describe('*** the UI-preference catalogue is closed, additive, and the only source of defaults ***', () => {
  it('is not empty — a guard over an empty catalogue proves nothing', () => {
    expect(UI_PREFERENCE_KEYS.length).toBeGreaterThan(0);
  });

  it.each(UI_PREFERENCE_KEYS)('`%s` has a non-empty value set containing its default', (key) => {
    const entry: UiPreferenceEntry = UI_PREFERENCES[key];
    expect(entry.values.length).toBeGreaterThan(0);
    expect(entry.values).toContain(entry.default);
  });

  it.each(UI_PREFERENCE_KEYS)('`%s` holds a CLOSED set — no free text can enter (FR-009)', (key) => {
    // The property that makes "no PII lives here" enforceable rather than aspirational: every value
    // is one of a handful of literals nobody can widen at runtime.
    const entry: UiPreferenceEntry = UI_PREFERENCES[key];
    expect(entry.values.every((v) => typeof v === 'string' && v.length > 0)).toBe(true);
    expect(entry.values.length).toBeLessThan(10);
  });

  it('every key resolves through `uiPreferenceOf`, and nothing else does', () => {
    for (const key of UI_PREFERENCE_KEYS) expect(uiPreferenceOf(key)).toBeDefined();
    expect(uiPreferenceOf('theme')).toBeUndefined();
    expect(uiPreferenceOf('preferences_json')).toBeUndefined();
    // Prototype keys are not catalogue members. `hasOwnProperty` rather than `in` is why.
    expect(uiPreferenceOf('toString')).toBeUndefined();
    expect(uiPreferenceOf('constructor')).toBeUndefined();
  });

  it('the default set is exactly the catalogue — both directions (FR-001)', () => {
    const defaults = defaultUiPreferences();
    expect(Object.keys(defaults).sort()).toEqual([...UI_PREFERENCE_KEYS].sort());
    for (const key of UI_PREFERENCE_KEYS) expect(defaults[key]).toBe(UI_PREFERENCES[key].default);
  });

  it('a fresh default set cannot be mutated into the catalogue', () => {
    // It is handed to callers on every read. If it were the catalogue object, one careless assignment
    // would change the default for every user in the process.
    const a = defaultUiPreferences();
    a.theme_mode = 'dark';
    expect(defaultUiPreferences().theme_mode).toBe(UI_PREFERENCES.theme_mode.default);
  });
});

describe('*** no default for a preference is defined anywhere but the catalogue (FR-006) ***', () => {
  /**
   * The structural half. A second place defining a default is how the server and the
   * server-rendered first paint end up disagreeing about what a new user sees — feature 017's
   * two-vocabularies-already-drifted, one layer up.
   */
  const SEARCH_ROOTS = ['services', 'web/src'];
  const CATALOGUE = 'libs/common/src/preferences/ui-preferences.ts';

  /**
   * ⚠️ **TEST FILES ARE OUT OF SCOPE, and this exclusion is the whole subtlety.**
   *
   * The first version of this guard scanned everything and went **red on three of feature 021's own
   * specs** — a failure that reached `main` and was caught by the project's **first ever CI run**, not
   * by me, because the gate had been measured before those specs took their final form.
   *
   * The predicate is `key` and `'<default>'` on one line. In a test that is not a second definition of
   * a default; it is a legal value being exercised. The clearest case:
   *
   *     await h.repo.apply(ACC, ME, [['theme_mode', 'light']]);
   *
   * `light` is one of exactly two legal values of `theme_mode`. Forbidding it near the key would make
   * the write path **untestable** — you cannot prove a setting can be set to light without naming
   * light. Same for a stubbed response, and same for an assertion that the default reaches the caller.
   *
   * What FR-006 actually protects against is a **second implementation deciding what a new user sees**
   * — the server saying one thing and the server-rendered first paint another (feature 017's
   * two-vocabularies-already-drifted, one layer up). A spec file cannot cause that disagreement. So
   * the guard keeps its full reach over production source and stops there.
   *
   * Generalisable, and now the **fourth** instance in this feature alone: *a guard that bans a token
   * from the source also bans the code that proves the behaviour* — the retraction comment three
   * times, and the test's own fixture here.
   */
  const isTestFile = (path: string): boolean =>
    /(^|\/)(tests|__tests__)\//.test(path) || /\.(spec|test)\.tsx?$/.test(path);

  /** Extracted so the self-check below exercises the pipeline rather than a regex. */
  function definesDefaultOutsideCatalogue(key: string, literal: string, source: string): boolean {
    return source.split('\n').some((line) => line.includes(key) && line.includes(`'${literal}'`));
  }

  it.each(UI_PREFERENCE_KEYS)(
    'the default value of `%s` is not hardcoded outside the catalogue',
    (key) => {
      const literal = UI_PREFERENCES[key].default;
      // `git grep` rather than a walk: it respects .gitignore and is the same view a reviewer has.
      let out = '';
      try {
        out = execSync(
          `git grep -l -F -e "${key}" -- ${SEARCH_ROOTS.map((r) => `"${r}"`).join(' ')}`,
          { cwd: ROOT, encoding: 'utf8' },
        );
      } catch (err) {
        // ⚠️ **`git grep` exits 1 for "no matches" and 128 for "I could not run" — and the blanket
        // `catch { out = '' }` this replaces collapsed the two into a clean result.** Found by mirroring
        // the CI job in a container whose mount was owned by another user: git refused with *dubious
        // ownership*, the guard scanned nothing, and the only thing that noticed was the reach
        // assertion below — which reported `Expected > 0, Received 0` and named no cause.
        //
        // A guard that cannot see the tree must say so. Silence here is the vacuous pass in its purest
        // form: permanently green, for as long as git is unavailable.
        const status = (err as { status?: number }).status;
        if (status !== 1) {
          throw new Error(
            `git grep could not run (exit ${String(status)}) — this guard scanned NOTHING. ` +
              `It is not a clean result. Original: ${(err as Error).message}`,
          );
        }
        out = '';
      }
      const matched = out.split('\n').filter(Boolean);

      // ⚠️ **The reach check is on the SEARCH, not on the production subset** — and the first draft of
      // this line got that wrong, asserting production code must name the key. It went red on
      // `font_size_step`, correctly: **nothing in production names a preference key, and that is the
      // design.** The catalogue drives storage, validation and serving generically, and a separate
      // test asserts no code branches on a key name. Demanding a production mention here would have
      // forced someone to add the very branch the feature exists to prevent.
      //
      // What must never silently become empty is the SEARCH itself — a `git grep` that matches nothing
      // (wrong cwd, renamed roots, a broken invocation) reads exactly like a clean result. That is the
      // vacuous-pass class this product has now hit eight times, so it is asserted rather than assumed.
      expect(matched.length).toBeGreaterThan(0);

      const offenders = matched
        .filter((f) => f !== CATALOGUE)
        .filter((f) => !isTestFile(f))
        .filter((f) =>
          definesDefaultOutsideCatalogue(key, literal, readFileSync(join(ROOT, f), 'utf8')),
        );

      expect(offenders).toEqual([]);
    },
  );

  describe('the detector can fail — proved on planted input, not asserted', () => {
    it('flags a second definition of a default in production-shaped source', () => {
      expect(definesDefaultOutsideCatalogue('theme_mode', 'light', "const theme_mode = 'light';")).toBe(
        true,
      );
    });

    it('does not flag the key and the value on different lines', () => {
      expect(
        definesDefaultOutsideCatalogue('theme_mode', 'light', "const key = theme_mode;\nconst v = 'light';"),
      ).toBe(false);
    });

    it('classifies test paths as tests and production paths as production', () => {
      // The exclusion is the part that can rot into a blanket amnesty, so its boundary is pinned.
      expect(isTestFile('services/users/src/preferences/ui-preferences.repository.spec.ts')).toBe(true);
      expect(isTestFile('services/chats/tests/isolation-014.spec.ts')).toBe(true);
      expect(isTestFile('web/src/components/theme.test.tsx')).toBe(true);
      expect(isTestFile('services/users/src/preferences/ui-preferences.repository.ts')).toBe(false);
      expect(isTestFile('services/gateway/src/preferences/ui-preferences.controller.ts')).toBe(false);
    });
  });
});

describe('*** patch validation refuses everything outside the catalogue ***', () => {
  it('accepts a valid partial patch and returns its entries', () => {
    const res = validateUiPreferencePatch({ theme_mode: 'dark' });
    expect(res).toEqual({ ok: true, entries: [['theme_mode', 'dark']] });
  });

  it('refuses an empty patch (FR-011)', () => {
    expect(validateUiPreferencePatch({})).toEqual({ ok: false, rejection: { reason: 'empty' } });
    expect(validateUiPreferencePatch(undefined)).toEqual({
      ok: false,
      rejection: { reason: 'empty' },
    });
  });

  it('refuses an unknown key, naming the key (FR-007)', () => {
    expect(validateUiPreferencePatch({ last_searched_player: 'p-1' })).toEqual({
      ok: false,
      rejection: { reason: 'unknown-key', key: 'last_searched_player' },
    });
  });

  it('refuses a value outside the key’s set, naming the key (FR-010)', () => {
    expect(validateUiPreferencePatch({ theme_mode: 'purple' })).toEqual({
      ok: false,
      rejection: { reason: 'value-not-allowed', key: 'theme_mode' },
    });
    expect(validateUiPreferencePatch({ font_size_step: 'enormous' })).toEqual({
      ok: false,
      rejection: { reason: 'value-not-allowed', key: 'font_size_step' },
    });
  });

  it('NEVER echoes the submitted value in the rejection (Principle IV)', () => {
    const secret = 'user@example.com';
    const res = validateUiPreferencePatch({ theme_mode: secret });
    expect(JSON.stringify(res)).not.toContain(secret);
  });

  it('a patch mixing one valid and one invalid key yields NO entries (FR-005)', () => {
    // The all-or-nothing case, and the one a naive per-key loop gets wrong: the caller gets an error
    // and the record changed anyway.
    const res = validateUiPreferencePatch({ theme_mode: 'dark', nope: 'x' });
    expect(res.ok).toBe(false);
  });

  it('accepts the FIRST and LAST value of every key — a guard that only rejects is half tested', () => {
    for (const key of UI_PREFERENCE_KEYS) {
      const values: readonly string[] = UI_PREFERENCES[key].values;
      expect(validateUiPreferencePatch({ [key]: values[0]! }).ok).toBe(true);
      expect(validateUiPreferencePatch({ [key]: values[values.length - 1]! }).ok).toBe(true);
    }
  });
});

describe('*** resolving stored rows over the defaults ***', () => {
  it('returns the complete set for a caller with no rows (FR-002)', () => {
    expect(resolveUiPreferences([])).toEqual(defaultUiPreferences());
  });

  it('a stored value overrides its default, and the untouched key keeps its default', () => {
    expect(resolveUiPreferences([{ key: 'theme_mode', value: 'dark' }])).toEqual({
      theme_mode: 'dark',
      font_size_step: 'default',
      unread_sound: 'on',
    });
  });

  it('IGNORES a stored key the catalogue no longer defines (FR-008)', () => {
    const out = resolveUiPreferences([
      { key: 'theme_mode', value: 'dark' },
      { key: 'retired_key', value: 'whatever' },
    ]);
    expect(out).not.toHaveProperty('retired_key');
    expect(out.theme_mode).toBe('dark');
  });

  it('IGNORES a stored value that is no longer allowed, falling back to the default', () => {
    // An allowed set can narrow. A read must not fail because of a decision made after the row was
    // written — otherwise retiring a value becomes a data migration.
    expect(resolveUiPreferences([{ key: 'theme_mode', value: 'sepia' }]).theme_mode).toBe(
      UI_PREFERENCES.theme_mode.default,
    );
  });
});

describe('*** the guard can FAIL — proved on a planted entry, not asserted ***', () => {
  /**
   * The self-check. Asserting that the real catalogue passes proves the real catalogue passes; it
   * says nothing about whether a bad entry would be caught. So the checks above are re-run here
   * against deliberately broken input.
   *
   * Two of these encode real mistakes: a default outside its own value set (an unreachable default,
   * so every new user gets something the UI cannot render) and an open-ended value set (the free-text
   * escape hatch this catalogue exists to forbid).
   */
  const check = (entry: UiPreferenceEntry) => ({
    defaultIsMember: entry.values.includes(entry.default),
    isClosed: entry.values.length > 0 && entry.values.length < 10,
  });

  it('catches a default that is not a member of its own value set', () => {
    expect(check({ values: ['light', 'dark'], default: 'system' }).defaultIsMember).toBe(false);
  });

  it('catches an empty value set — the free-text escape hatch', () => {
    expect(check({ values: [], default: '' }).isClosed).toBe(false);
  });

  it('passes a well-formed entry, so the checks are not simply always false', () => {
    const ok = check({ values: ['a', 'b'], default: 'a' });
    expect(ok.defaultIsMember && ok.isClosed).toBe(true);
  });

  it('a planted unknown key IS rejected by the real validator', () => {
    expect(validateUiPreferencePatch({ planted_phantom_key: 'x' }).ok).toBe(false);
  });
});
