/**
 * The operator UI-preference catalogue (feature 021, roadmap 5.6 — ADR 0035 §7).
 *
 * ── ⚠️ NOT `Player.preferences_json` ─────────────────────────────────────────────────────────────
 * That field is the **customer's** preferences — VIP portfolio data about a real human being, tier
 * `am_only`, masked from most roles. Everything in this file is the **operator's** own appearance
 * settings: cosmetic, self-owned, readable by nobody else, gated by no permission.
 *
 * Two completely different things, and they are named apart on purpose: a search for
 * `preferences_json` must never return this file, and a search for `UiPreference` must never return
 * the customer's field. This is the roadmap-4.15 failure shape — "custom attributes" existed on
 * `Player` while the requirement meant `Conversation`, and the name being taken is what made everyone
 * assume the thing was built.
 *
 * ── Why a catalogue rather than free-form keys ───────────────────────────────────────────────────
 * Closed and additive, the sixth in this product after the permission catalogue (011), the automation
 * vocabulary (014), the audit actions (015), the upload purposes (016) and the export scopes (017).
 * Without it, "just one more thing to remember per user" turns this record into a bucket holding a
 * draft message, a last-searched player id and a phone number — none of it ever reviewed against the
 * PII rules. Every value set here is a closed enumeration, which is what makes "no PII lives here" a
 * property rather than an aspiration.
 *
 * ── What is deliberately NOT in an entry ─────────────────────────────────────────────────────────
 * **No `permission` field.** ADR 0035 draws the line: hiding something through a preference is not a
 * restriction, and revealing something through a preference cannot grant access. A field for it here
 * is the first step toward a second, unaudited access-control system.
 *
 * **No `type` field.** Every value is a member of a closed set, so there is nothing to discriminate
 * on — and a `type: 'string'` escape hatch is exactly how the first free-text preference would arrive.
 *
 * ── ADR 0035's hygiene rule, applied ─────────────────────────────────────────────────────────────
 * "A setting is added only when there is a genuine disagreement about the default." Two entries, not
 * five. Every switch is a permanent multiplier on test combinations and support conversations.
 */

export interface UiPreferenceEntry {
  /** The closed set of values this key accepts. A value outside it is refused (FR-010). */
  readonly values: readonly string[];
  /** What a caller gets when the key was never set. Defined HERE and nowhere else (FR-006). */
  readonly default: string;
}

/**
 * ⚠️ Adding a key here is the entire cost of adding a preference: no migration, no backfill, no
 * change to the read path. Every existing record reports the new key at its default immediately
 * (SC-006). That property is why this is a catalogue and not columns.
 */
export const UI_PREFERENCES = {
  /**
   * Light or dark **within the brand's token set**. The brand supplies the values for both sets
   * (ADR 0028); the user never picks colors, only which of the two applies (0035 §7 precedence).
   *
   * ⚠️ There is deliberately no "follow the operating system" value. It reads as the obvious third
   * option and it reintroduces the exact problem 0035 §7 exists to prevent: the OS preference cannot
   * be known on the server, so a server-rendered page could not resolve it and would paint light
   * before flipping. Adding the value later is additive; removing it would not be.
   */
  theme_mode: { values: ['light', 'dark'], default: 'light' },

  /**
   * The three accessibility font-size steps (0035 §3), applied by scaling the 0031 type-scale
   * tokens — never by per-component overrides.
   */
  font_size_step: { values: ['compact', 'default', 'large'], default: 'default' },

  /**
   * ⭐ W25 (R23 / roadmap 9.12): the quiet arrival sound's PERSONAL switch — «настраиваемый актив с
   * личным выключателем». Genuine disagreement about the default exists (0035's hygiene rule): the
   * badge exists because email arrivals were silent, so the sound defaults ON — and the person who
   * shares an office mutes THEIR OWN client without touching anyone else's.
   */
  unread_sound: { values: ['on', 'off'], default: 'on' },
} as const satisfies Record<string, UiPreferenceEntry>;

export type UiPreferenceKey = keyof typeof UI_PREFERENCES;

/** Every key, in catalogue order. */
export const UI_PREFERENCE_KEYS = Object.keys(UI_PREFERENCES) as UiPreferenceKey[];

/** The entry for a key, or `undefined`. There is no permissive fallback, on purpose. */
export function uiPreferenceOf(key: string): UiPreferenceEntry | undefined {
  return Object.prototype.hasOwnProperty.call(UI_PREFERENCES, key)
    ? UI_PREFERENCES[key as UiPreferenceKey]
    : undefined;
}

/**
 * The complete default set.
 *
 * A read always returns every key (FR-001), so no client ever has to know a default — which is what
 * keeps the defaults from being copied into the web app and drifting. Feature 017 found two
 * vocabularies that had already diverged before anyone noticed; one source is the fix.
 */
export function defaultUiPreferences(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of UI_PREFERENCE_KEYS) out[key] = UI_PREFERENCES[key].default;
  return out;
}

/** Why a patch was refused. The key is named; the submitted value never is. */
export interface UiPreferenceRejection {
  readonly reason: 'empty' | 'unknown-key' | 'value-not-allowed';
  /** Absent only for `empty`. */
  readonly key?: string;
}

export type UiPreferencePatchResult =
  | { readonly ok: true; readonly entries: ReadonlyArray<readonly [string, string]> }
  | { readonly ok: false; readonly rejection: UiPreferenceRejection };

/**
 * Validate a partial patch — **all of it, before any of it is written** (FR-005).
 *
 * A partially applied write is the worst outcome available here: the caller receives an error and the
 * record changed anyway. Returning the validated entries rather than a boolean is what makes the
 * "validate everything first" ordering hard to get wrong at the call site — there is nothing to write
 * until this function has said yes.
 *
 * ⚠️ **The rejection names the KEY and never the VALUE.** The key set is closed and its shape is not
 * a secret — the same reasoning the upload-purpose catalogue uses when it answers an unknown purpose
 * plainly. Echoing an arbitrary submitted value back into an error message is how unvalidated input
 * reaches a log (Principle IV).
 */
export function validateUiPreferencePatch(
  patch: Readonly<Record<string, string>> | undefined,
): UiPreferencePatchResult {
  const pairs = Object.entries(patch ?? {});
  // An empty change is a caller defect, not a no-op to absorb silently (FR-011).
  if (pairs.length === 0) return { ok: false, rejection: { reason: 'empty' } };

  for (const [key, value] of pairs) {
    const entry = uiPreferenceOf(key);
    if (!entry) return { ok: false, rejection: { reason: 'unknown-key', key } };
    if (!entry.values.includes(value))
      return { ok: false, rejection: { reason: 'value-not-allowed', key } };
  }
  return { ok: true, entries: pairs };
}

/**
 * Merge stored rows over the defaults into the complete set a caller receives (FR-001).
 *
 * Two kinds of stored row are IGNORED rather than surfaced, and both are deliberate:
 *
 *  • a key the catalogue no longer defines (FR-008) — a key can be retired, and a read must not fail
 *    because of a decision made after the row was written;
 *  • a value no longer in its key's allowed set — an allowed set can narrow, same reasoning.
 *
 * The alternative in both cases is an error on read, which would make retiring anything a migration.
 */
export function resolveUiPreferences(
  stored: ReadonlyArray<{ readonly key: string; readonly value: string }>,
): Record<string, string> {
  const out = defaultUiPreferences();
  for (const row of stored) {
    const entry = uiPreferenceOf(row.key);
    if (entry && entry.values.includes(row.value)) out[row.key] = row.value;
  }
  return out;
}
